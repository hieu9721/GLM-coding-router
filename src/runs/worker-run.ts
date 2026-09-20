import os from "node:os";
import type { RouterConfig } from "../core/config.js";
import { ExitCode, formatGlmError, GlmRouterError } from "../core/errors.js";
import { logger } from "../core/logging.js";
import { runDir } from "../core/paths.js";
import { spawnAgentStream } from "../core/process.js";
import { createEventBus } from "../events/bus.js";
import type { EventInput } from "../events/bus.js";
import type { AgentRole, WorkerEvent } from "../events/types.js";
import { createStreamAdapter } from "../events/claude-adapter.js";
import { attachProgress, resolveProgressMode } from "../tui/progress.js";
import type { ProgressMode } from "../tui/progress.js";
import { createRun, finishRun, pruneHistory, taskHashOf, taskTitleOf } from "./registry.js";
import { startHeartbeat } from "./heartbeat.js";
import type { HeartbeatHandle } from "./heartbeat.js";
import { openRunStore, summarize } from "./store.js";
import type { RunStore } from "./store.js";
import { runId } from "./ulid.js";

/**
 * The single instrumented orchestration path shared by `glm-worker`,
 * `glm-review` and the MCP tools (specs/v2-architecture.md, Phase D). Wires
 * the Phase A adapter, the Phase B registry/store, the Phase C renderer and
 * the streaming spawn into one run.
 *
 * Two channels that must never meet (contracts C1/C3):
 * - the run's FINAL TEXT goes to stdout, once, at the end — a parent agent
 *   parses it;
 * - everything else (events, progress, diagnostics) goes to events.jsonl and
 *   stderr, and never carries the final text, the prompt body or any LLM
 *   response body.
 *
 * Observability must never break a run that would otherwise have worked: every
 * persistence/renderer failure below is contained at debug level, and the
 * child is spawned and its output printed regardless.
 */
export interface WorkerRunOptions {
  /** Which CLI surface started the run; persisted in the RunStarted event. */
  readonly kind: "worker" | "review" | "delegate";
  /** Defaults to `reviewer` for review runs, `worker` otherwise. */
  readonly role?: AgentRole;
  /** For taskTitle/taskHash only — never persisted raw (C3). */
  readonly prompt: string;
  /** Already built by buildWorkerArgs/buildReviewArgs; the observation flags are appended here. */
  readonly args: readonly string[];
  readonly claudePath: string;
  readonly config: RouterConfig;
  /** Resolved key(s), so derived titles can be redacted against them. */
  readonly secrets: readonly (string | undefined)[];
  readonly cwd: string;
  /** The child env (createGlmEnv output). */
  readonly env: NodeJS.ProcessEnv;
  /** Config home; defaults to os.homedir(). */
  readonly home?: string;
  /** Explicit mode wins outright; "auto" (the default) resolves from flags/env/config/TTY. */
  readonly progress?: ProgressMode | "auto";
  readonly quiet?: boolean;
  readonly noProgress?: boolean;
  /** Where the final text lands; defaults to process.stdout (contract C1). */
  readonly stdout?: { write(text: string): void };
  /** Progress + diagnostics channel; defaults to process.stderr. */
  readonly stderr?: NodeJS.WriteStream | NodeJS.WritableStream;
  readonly now?: () => Date;
  /** Injectable so tests can observe (or fake) the spawn without a child. */
  readonly spawnImpl?: typeof spawnAgentStream;
}

export interface WorkerRunResult {
  /** Process exit code to use: 0 on success, 40 on child failure (v1's code). */
  readonly code: number;
  readonly runId: string;
  readonly runDir: string;
}

/** Which orchestrator, if any, is above this process. */
export type ParentType = "claude" | "codex" | "shell";

/**
 * `CLAUDECODE=1` is set inside Claude Code subagents; Codex has no single
 * marker variable, so any `CODEX_SESSION` or a value naming codex counts.
 * Everything else is a human at a shell. Kept here, exported, so the v1
 * surfaces (part 3) and the tests share one definition.
 */
export function detectParent(env: NodeJS.ProcessEnv): ParentType {
  if (env.CLAUDECODE === "1") {
    return "claude";
  }
  if (env.CODEX_SESSION !== undefined) {
    return "codex";
  }
  for (const value of Object.values(env)) {
    if (typeof value === "string" && value.includes("codex")) {
      return "codex";
    }
  }
  return "shell";
}

/**
 * The legacy escape hatch (contract C4). False when the caller already passed
 * `--output-format` (`benchmark` does, with `json`) or set
 * `GLM_ROUTER_OBSERVE=off`: those callers must use the exact v1 inherit path
 * instead — no registry, no adapter, byte-identical behavior.
 * `runInstrumented` assumes it is only called when this returns true.
 */
export function shouldObserve(args: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (env.GLM_ROUTER_OBSERVE === "off") {
    return false;
  }
  return !args.includes("--output-format");
}

/**
 * One instrumented run. Never throws: a spawn that cannot even start maps to
 * exit code 40 with the diagnostic on stderr, exactly like v1's
 * CHILD_AGENT_FAILED, and everything observability-related degrades quietly.
 */
export async function runInstrumented(options: WorkerRunOptions): Promise<WorkerRunResult> {
  const now = options.now ?? ((): Date => new Date());
  const home = options.home ?? os.homedir();
  // The only two places the real process streams are ever referenced: the
  // documented defaults (contract C1 keeps stdout reserved for the final text).
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const startedAt = now();
  const id = runId(() => startedAt.getTime());
  const date = startedAt.toISOString().slice(0, 10);
  const dir = runDir(home, date, id);
  const role: AgentRole = options.role ?? (options.kind === "review" ? "reviewer" : "worker");

  // Retention is opportunistic by design: a pruning failure must never block
  // the work around it (pruneHistory already swallows per-run errors; this
  // catch is for the listing itself).
  try {
    pruneHistory(home, options.config.history);
  } catch (error) {
    logger.debug(`worker-run: history pruning failed: ${errorMessage(error)}`);
  }

  // C3: the first prompt line, redacted, and a hash of the full prompt are the
  // only prompt-derived values that ever reach disk.
  const taskTitle = taskTitleOf(options.prompt, options.secrets);
  const taskHash = taskHashOf(options.prompt);

  // Registry: an unwritable home (full disk, read-only volume) must not stop
  // the user's work — the run continues without persistence.
  let registered = false;
  try {
    createRun(
      {
        id,
        kind: options.kind,
        provider: "zai.zcode",
        role,
        model: options.config.models.main,
        cwd: options.cwd,
        startedAt: startedAt.toISOString(),
        parent: { type: detectParent(options.env) },
        taskTitle,
        taskHash,
        pid: process.pid,
        date,
      },
      { home, now: () => startedAt },
    );
    registered = true;
  } catch (error) {
    logger.debug(`worker-run: run registry unavailable, continuing without persistence: ${errorMessage(error)}`);
  }

  const bus = createEventBus(id, { role, now });
  const seen: WorkerEvent[] = [];
  bus.subscribe((event) => seen.push(event));
  let store: RunStore | null = null;
  if (registered) {
    try {
      store = openRunStore(dir);
    } catch (error) {
      logger.debug(`worker-run: run store unavailable, events will not be persisted: ${errorMessage(error)}`);
    }
  }
  if (store !== null) {
    // `target` holds the narrowed handle: `store` is reassigned below, which
    // would invalidate the narrowing inside the closure.
    const target: RunStore = store;
    bus.subscribe((event) => target.append(event));
  }

  const progressMode = resolveRunProgressMode(options, stderr);
  let detachProgress = (): void => {};
  try {
    detachProgress = attachProgress(bus, { mode: progressMode, stream: stderr }).detach;
  } catch (error) {
    logger.debug(`worker-run: progress renderer unavailable: ${errorMessage(error)}`);
  }

  const adapter = createStreamAdapter(options.cwd);

  // The stdout contract (C1) lives in these three locals. `finalText` is the
  // ONLY copy of the run's final answer, it never touches an event, a log line
  // or the store, and it is written to stdout exactly once at the end.
  let finalText: string | undefined;
  let sawRunCompleted = false;
  let currentTurn = 0;
  let childCode: number | null = null;
  let spawnFailure: unknown = null;
  let heartbeat: HeartbeatHandle | null = null;

  const dispatch = (events: readonly EventInput[]): void => {
    for (const event of events) {
      if (event.type === "TurnStarted") {
        currentTurn = event.turn;
      }
      if (event.type === "RunCompleted") {
        sawRunCompleted = true;
      }
      bus.emit(event);
    }
  };

  const handleStdoutLine = (line: string): void => {
    try {
      captureResultText(line);
      dispatch(adapter.onStdoutLine(line));
    } catch (error) {
      logger.debug(`worker-run: stdout line handling failed: ${errorMessage(error)}`);
    }
  };

  const handleStderrLine = (line: string): void => {
    try {
      dispatch(adapter.onStderrLine(line));
      // Passthrough: real Claude diagnostics (and retry notices) must stay
      // visible to whoever is watching stderr.
      stderr.write(line + "\n");
    } catch (error) {
      logger.debug(`worker-run: stderr line handling failed: ${errorMessage(error)}`);
    }
  };

  /** Remembers `result` from the stream's final `{"type":"result",…}` line. */
  const captureResultText = (line: string): void => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed.startsWith("{")) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // not JSON — the adapter logs its own debug line for this text
    }
    if (!isRecord(parsed)) {
      return;
    }
    if (parsed.type === "result" && typeof parsed.result === "string") {
      finalText = parsed.result;
    }
  };

  try {
    bus.emit({
      type: "RunStarted",
      kind: options.kind,
      model: options.config.models.main,
      cwd: options.cwd,
      taskTitle,
      taskHash,
      parent: { type: detectParent(options.env) },
    });
  } catch (error) {
    logger.debug(`worker-run: RunStarted emit failed: ${errorMessage(error)}`);
  }

  try {
    heartbeat = startHeartbeat({
      bus,
      home,
      runId: id,
      getState: () => "RUNNING",
      getTurn: () => currentTurn,
    });
  } catch (error) {
    logger.debug(`worker-run: heartbeat unavailable: ${errorMessage(error)}`);
  }

  try {
    // Both flags together: claude 2.1.278 rejects stream-json without
    // --verbose (captured evidence, A0). Callers reach here only when
    // shouldObserve is true, so no --output-format is already present.
    const child = await (options.spawnImpl ?? spawnAgentStream)(options.claudePath, {
      args: [...options.args, "--output-format", "stream-json", "--verbose"],
      cwd: options.cwd,
      env: options.env,
      onStdoutLine: handleStdoutLine,
      onStderrLine: handleStderrLine,
    });
    childCode = child.code;
  } catch (error) {
    spawnFailure = error;
  } finally {
    // Always: a leaked ticker would keep the process open and keep emitting
    // events into a run that is already over.
    heartbeat?.stop();
  }

  if (finalText !== undefined) {
    stdout.write(finalText.endsWith("\n") ? finalText : finalText + "\n");
  }
  if (spawnFailure !== null) {
    // v1 maps an unspawnable child to CHILD_AGENT_FAILED (exit 40); keep the
    // formatted diagnostic on stderr so the reason stays visible.
    const text =
      spawnFailure instanceof GlmRouterError
        ? formatGlmError(spawnFailure)
        : `worker-run: child process failed: ${errorMessage(spawnFailure)}`;
    try {
      stderr.write(text + "\n");
    } catch (error) {
      logger.debug(`worker-run: writing spawn failure diagnostic failed: ${errorMessage(error)}`);
    }
  }

  try {
    if (registered) {
      finishRun(home, id, summarize(seen));
    }
  } catch (error) {
    logger.debug(`worker-run: writing summary failed: ${errorMessage(error)}`);
  }

  detachProgress();
  try {
    store?.close();
  } catch (error) {
    logger.debug(`worker-run: closing the run store failed: ${errorMessage(error)}`);
  }
  bus.close();

  const code =
    childCode === ExitCode.Success && sawRunCompleted ? ExitCode.Success : ExitCode.ChildAgentFailed;
  return { code, runId: id, runDir: dir };
}

/** An explicit mode wins outright; "auto" defers to the Phase C resolution order. */
function resolveRunProgressMode(
  options: WorkerRunOptions,
  stderr: NodeJS.WriteStream | NodeJS.WritableStream,
): ProgressMode {
  if (options.progress !== undefined && options.progress !== "auto") {
    return options.progress;
  }
  // NodeJS.WritableStream does not declare terminal-only members, so narrow
  // through a structural shape (same trick as src/tui/render.ts).
  const terminal = stderr as { isTTY?: boolean };
  return resolveProgressMode({
    flagOff: options.noProgress,
    quiet: options.quiet,
    configMode: options.config.ui.mode,
    env: options.env,
    isTTY: terminal.isTTY === true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
