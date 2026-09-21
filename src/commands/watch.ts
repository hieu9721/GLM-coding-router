import fs from "node:fs";
import os from "node:os";
import { loadConfig } from "../core/config.js";
import { Errors } from "../core/errors.js";
import { logger } from "../core/logging.js";
import { activeRunFile, runDir } from "../core/paths.js";
import { createEventBus } from "../events/bus.js";
import type { WorkerEvent } from "../events/types.js";
import { listActive, listHistory, type ActiveRun } from "../runs/registry.js";
import { eventsFilePath } from "../runs/store.js";
import { attachProgress, resolveProgressMode } from "../tui/progress.js";
import type { GlobalOptions } from "./context.js";

/**
 * fs.watch is the primary follow mechanism but is unreliable on some platforms
 * (and fires spuriously on others), so a slow interval re-reads from the last
 * offset as a backstop — never as a tight poll loop.
 */
const DEFAULT_FALLBACK_INTERVAL_MS = 1000;

/** The events that end a run; seeing one means there is nothing left to follow. */
const TERMINAL_EVENT_TYPES = new Set(["RunCompleted", "RunFailed", "RunCancelled"]);

export interface WatchOptions {
  /** Full id or unique suffix, exactly like `runs show`; omitted = newest active run. */
  readonly runId?: string;
  /** Render the events written before attaching, then follow. */
  readonly fromStart?: boolean;
}

/** Injectable stand-in for `fs.watch`, so tests never depend on platform events. */
export type FileWatch = (file: string, onChange: () => void) => { close(): void };

export interface WatchDeps {
  readonly home?: string;
  /** The renderer's target — production passes `process.stderr`, tests a memory stream. */
  readonly stderr?: NodeJS.WriteStream | NodeJS.WritableStream;
  /** Backstop re-read interval; small in tests so the follow responds quickly. */
  readonly intervalMs?: number;
  /** Replaces `fs.watch` entirely when provided (tests pass a no-op). */
  readonly watchImpl?: FileWatch;
}

/** What id resolution found: a live run, a finished one, or nothing at all. */
type WatchTarget =
  | { readonly kind: "active"; readonly run: ActiveRun }
  | { readonly kind: "finished"; readonly id: string; readonly state: string }
  | { readonly kind: "none" };

/**
 * glm-router watch [run-id] — attach to a running run and follow it live. The
 * stored events are re-emitted onto a fresh bus that `attachProgress` renders
 * through, so a followed run prints exactly what a live one prints. Attaching
 * reads from the CURRENT end of `events.jsonl` (`--from-start` rewinds to 0):
 * the user wants what happens from now on, not a replay of what they missed.
 * Exit 0 on every stop — a run ending, crashing or being interrupted is what
 * watching is for, not a failure of the command.
 */
export function watchCommand(options: GlobalOptions & WatchOptions, deps: WatchDeps = {}): Promise<number> {
  const home = deps.home ?? os.homedir();
  const target = resolveTarget(home, options.runId);
  if (target.kind === "none") {
    // Nothing running is normal, not an error — one clear line, exit 0.
    process.stdout.write("no active run\n");
    return Promise.resolve(0);
  }
  if (target.kind === "finished") {
    process.stdout.write(`run ${target.id} already finished (${target.state}) — nothing to follow\n`);
    return Promise.resolve(0);
  }

  const run = target.run;
  const stream = deps.stderr ?? process.stderr;
  const intervalMs = deps.intervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS;
  const file = eventsFilePath(runDir(home, run.date, run.id));
  const activeFile = activeRunFile(home, run.id);
  // The registry is the fast path, but the events are the truth: a run whose
  // last recorded event is terminal is over even while a stale active file
  // still lists it (a crash between summary and cleanup leaves exactly that).
  // Following such a file would hang forever, so say so and leave.
  if (options.fromStart !== true) {
    const ended = lastTerminalEventType(file);
    if (ended !== null) {
      process.stdout.write(`run ${run.id} already ended (${ended}) — nothing to follow\n`);
      return Promise.resolve(0);
    }
  }
  // Same mode resolution as a live run, so the two views cannot diverge.
  const mode = resolveProgressMode({
    quiet: options.quiet,
    configMode: loadConfig(home).ui.mode,
    env: process.env,
    isTTY: streamIsTTY(stream),
  });
  const bus = createEventBus(run.id);
  const progress = attachProgress(bus, { mode, stream });

  return new Promise<number>((resolve) => {
    // Bytes below `offset` have been consumed; `pending` holds a torn final
    // line until its remainder arrives (the store appends whole lines, so a
    // torn line is the normal mid-append state, not corruption).
    let offset = options.fromStart === true ? 0 : fileSize(file);
    let pending = Buffer.alloc(0);
    let watcher: { close(): void } | null = null;
    let timer: NodeJS.Timeout | null = null;
    let stopped = false;

    const stop = (code: number): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
      }
      watcher?.close();
      process.removeListener("SIGINT", onSigint);
      progress.detach(); // restores the cursor in rich mode
      bus.close();
      resolve(code);
    };
    const onSigint = (): void => {
      stop(0);
    };

    /** A transient fs error inside a timer/watch callback must not kill node. */
    const pump = (): void => {
      if (stopped) {
        return;
      }
      try {
        pumpOnce();
      } catch (error) {
        logger.debug(`watch: pumping ${file} failed: ${errorMessage(error)}`);
      }
    };

    const pumpOnce = (): void => {
      // A stat failure (file not created yet by a very fresh run, or a prune
      // racing the watch) reads as "nothing new" — the active-file check below
      // is the only authority on whether the run itself ended.
      const size = fileSize(file);
      if (size > offset) {
        const chunk = readRange(file, offset, size - offset);
        offset = size;
        pending = Buffer.concat([pending, chunk]);
      }
      // Only newline-terminated lines are parsed; anything else waits for the
      // next pump, which is what makes a mid-append read harmless.
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline === -1) {
          break;
        }
        const line = pending.subarray(0, newline).toString("utf8").trim();
        pending = pending.subarray(newline + 1);
        const event = parseStoredEvent(line);
        if (event === null) {
          continue;
        }
        // The bus re-stamps seq/ts on replay; nothing downstream of a watch
        // renders those fields, and a single emit authority stays simpler
        // than a bypass that would let two writers disagree.
        bus.emit(event);
        if (TERMINAL_EVENT_TYPES.has(event.type)) {
          stop(0);
          return;
        }
      }
      // Every terminal event is appended before the active file is deleted,
      // so at this point a missing active file means the run died without
      // one (crash) — the pump above already delivered its last events.
      if (!fs.existsSync(activeFile)) {
        process.stdout.write(`run ${run.id} is no longer active — no terminal event was recorded\n`);
        stop(0);
      }
    };

    const tryStartFsWatch = (): void => {
      if (watcher !== null || stopped) {
        return;
      }
      try {
        watcher = fs.watch(file, () => {
          pump();
        });
      } catch (error) {
        // A run so fresh that events.jsonl does not exist yet — the backstop
        // tick retries until the store creates it.
        logger.debug(`watch: fs.watch on ${file} failed: ${errorMessage(error)}`);
      }
    };

    process.on("SIGINT", onSigint);
    if (options.fromStart === true) {
      pump();
    }
    if (!stopped) {
      if (deps.watchImpl !== undefined) {
        watcher = deps.watchImpl(file, pump);
      } else {
        tryStartFsWatch();
      }
      timer = setInterval(() => {
        if (deps.watchImpl === undefined) {
          tryStartFsWatch();
        }
        pump();
      }, intervalMs);
      // fs.watch keeps the loop alive on its own; the interval is only a
      // backstop and must not become a second reason to stay alive. When it
      // IS the mechanism (watchImpl injected, or fs.watch never started), it
      // stays referenced — otherwise node would exit mid-follow.
      if (deps.watchImpl === undefined && watcher !== null) {
        timer.unref();
      }
    }
  });
}

/**
 * Full id or unique suffix, exact match first, ambiguity named — the same
 * rule as `runs show`. A suffix can also hit history: a finished run is
 * reported as such rather than "not found" (which would be false) — and
 * watching one would hang forever, so the caller prints and exits instead.
 */
function resolveTarget(home: string, input: string | undefined): WatchTarget {
  const activeRuns = listActive(home); // newest first
  if (input === undefined) {
    return activeRuns.length > 0 ? { kind: "active", run: activeRuns[0] } : { kind: "none" };
  }
  const exact = activeRuns.find((run) => run.id === input);
  if (exact !== undefined) {
    return { kind: "active", run: exact };
  }
  const suffix = activeRuns.filter((run) => run.id.endsWith(input));
  if (suffix.length === 1) {
    return { kind: "active", run: suffix[0] };
  }
  if (suffix.length > 1) {
    throw Errors.invalidArgs(
      `run id "${input}" is ambiguous — ${suffix.length} active runs end with it:`,
      suffix.map((run) => run.id),
    );
  }
  const refs = listHistory(home);
  const refExact = refs.find((ref) => ref.id === input);
  const refSuffix = refs.filter((ref) => ref.id.endsWith(input));
  const match = refExact ?? (refSuffix.length === 1 ? refSuffix[0] : undefined);
  if (refExact === undefined && refSuffix.length > 1) {
    throw Errors.invalidArgs(
      `run id "${input}" is ambiguous — ${refSuffix.length} recorded runs end with it:`,
      refSuffix.map((candidate) => candidate.id),
    );
  }
  if (match !== undefined) {
    return { kind: "finished", id: match.id, state: match.state };
  }
  throw Errors.invalidArgs(`no run found with id "${input}"`, [`Run "glm-router runs" to list recorded runs.`]);
}

/**
 * The runtime check mirrors `readEvents`: "parses and has a `type` string".
 * History written by a future version must degrade to an ignored line, not
 * crash the watcher.
 */
function parseStoredEvent(line: string): WorkerEvent | null {
  if (line === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string") {
      return parsed as WorkerEvent;
    }
  } catch {
    // A malformed newline-terminated line is skipped, like readEvents skips it.
  }
  return null;
}

/** Reads exactly [offset, offset+length) — a follow must never re-read bytes. */
function readRange(file: string, offset: number, length: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, offset);
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * The `type` of the last COMPLETE line, when that type is terminal — null
 * otherwise (including "file missing" and "last line torn", which both mean
 * "keep following"). Only the file's tail is read; one event line is far
 * smaller than the 8 KiB window.
 */
function lastTerminalEventType(file: string): string | null {
  const size = fileSize(file);
  if (size === 0) {
    return null;
  }
  const length = Math.min(size, 8192);
  const body = readRange(file, size - length, length).toString("utf8");
  const terminated = body.endsWith("\n") ? body.slice(0, -1) : body;
  const lastNewline = terminated.lastIndexOf("\n");
  if (lastNewline !== -1 || length === size) {
    const line = (lastNewline === -1 ? terminated : terminated.slice(lastNewline + 1)).trim();
    const event = parseStoredEvent(line);
    if (event !== null && TERMINAL_EVENT_TYPES.has(event.type)) {
      return event.type;
    }
  }
  return null;
}

/** NodeJS.WritableStream has no terminal members; narrow structurally. */
function streamIsTTY(stream: NodeJS.WriteStream | NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
