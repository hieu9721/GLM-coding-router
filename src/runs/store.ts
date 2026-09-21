import fs from "node:fs";
import path from "node:path";
import { logger } from "../core/logging.js";
import type { WorkerEvent } from "../events/types.js";

/** The one file every run is guaranteed to leave behind, even when it crashed. */
export const EVENTS_FILE_NAME = "events.jsonl";

/** `events.jsonl` inside a run directory; exported so every module spells the path the same way. */
export function eventsFilePath(runDirPath: string): string {
  return path.join(runDirPath, EVENTS_FILE_NAME);
}

/**
 * Terminal state of a run as rebuilt from its event stream. `CRASHED` is not an
 * event anyone emits — it is the absence of a terminal event, which is exactly
 * what a killed process leaves behind, so `runs show` can still classify it.
 */
export type RunOutcome = "COMPLETED" | "FAILED" | "CANCELLED" | "CRASHED";

/**
 * Validation outcome rebuilt from events: the last completed validation wins;
 * a started-but-never-completed validation that was denied is `denied` (A0
 * showed denied validations are a real, reportable outcome, not an error),
 * one still running at stream end is `pending`, and no validation at all is
 * `none`.
 */
export type ValidationOutcome = "ok" | "failed" | "denied" | "pending" | "none";

/**
 * What `finishRun` writes to `summary.json`. Deliberately contains no prompt
 * text beyond nothing at all — the title and hash live in the run metadata,
 * the summary carries only counts and paths (contract C3).
 */
export interface RunSummary {
  readonly id: string;
  readonly state: RunOutcome;
  readonly turns: number;
  readonly durationMs: number;
  readonly filesChanged: readonly string[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Count of `ToolDenied` events — denied tools are reported, not swallowed. */
  readonly denied: number;
  /** Count of `ApiRetry` events, a signal the endpoint was struggling. */
  readonly retries: number;
  readonly validation: ValidationOutcome;
  /**
   * What preflight would have done, recorded whether or not it was enforced
   * (Phase E, decision D3). This is the evidence 2.1's "flip refuseOnCritical
   * to true?" question is answered from: a `wouldRefuse: true` next to the
   * `actualCredits` that run really consumed says directly how often the
   * refusal would have been wrong. Absent on runs that were never routed
   * (preflight unavailable, or a v1-path run), and `actualCredits` is null
   * when the measurement was not clean enough to attribute.
   */
  readonly routingAdvice?: {
    readonly wouldRefuse: boolean;
    readonly estimatedCost: number;
    readonly usableBudget: number;
    readonly zone: string;
    readonly actualCredits: number | null;
  };
}

export interface RunStore {
  /** One JSON line per event, written to the OS immediately (no buffering). */
  append(event: WorkerEvent): void;
  /** Make everything appended so far durable. */
  flush(): void;
  /** flush + release the file handle. Idempotent. */
  close(): void;
  readonly path: string;
}

/**
 * Opens `events.jsonl` in append mode. Append mode is the whole crash story:
 * the file is never truncated, every line reaches the OS as it is appended,
 * and a killed process leaves at worst one half-written final line — which
 * `readEvents` tolerates — and never a summary, which is precisely how
 * `runs show` tells a crashed run from a finished one.
 *
 * `append` may throw (disk full, fd gone); the event bus catches subscriber
 * exceptions, so a broken store degrades to lost lines instead of a dead run.
 */
export function openRunStore(runDirPath: string): RunStore {
  fs.mkdirSync(runDirPath, { recursive: true });
  const file = eventsFilePath(runDirPath);
  const fd = fs.openSync(file, "a");
  let closed = false;

  return {
    path: file,
    append(event: WorkerEvent): void {
      if (closed) {
        logger.debug(`run store: append after close on ${file} skipped`);
        return;
      }
      fs.writeSync(fd, JSON.stringify(event) + "\n", null, "utf8");
    },
    flush(): void {
      if (!closed) {
        fs.fsyncSync(fd);
      }
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

/**
 * Reconstructs the event stream from a run directory. A malformed line is
 * skipped, not fatal — a truncated final line is the normal wreckage of a
 * crash, and the events before it are exactly what survived. A missing file
 * yields an empty stream for the same reason: history readers must never
 * throw on the artifacts a crash leaves behind.
 */
export function readEvents(runDirPath: string): WorkerEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(eventsFilePath(runDirPath), "utf8");
  } catch {
    logger.debug(`run store: no events file in ${runDirPath}`);
    return [];
  }

  const events: WorkerEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEventLike(parsed)) {
        events.push(parsed);
      } else {
        logger.debug(`run store: line ${index + 1} in ${runDirPath} is not an event`);
      }
    } catch {
      logger.debug(`run store: skipping malformed line ${index + 1} in ${runDirPath}`);
    }
  }
  return events;
}

/**
 * Rebuilds a summary from events alone. The stream's `RunCompleted` numbers
 * (A0: taken straight from the result message) are authoritative when
 * present; the event-derived fallbacks exist so a crashed run still gets a
 * meaningful summary — that is the entire point of rebuilding rather than
 * trusting a file the crash prevented us from writing.
 */
export function summarize(events: readonly WorkerEvent[]): RunSummary {
  let state: RunOutcome = "CRASHED";
  let turns = 0;
  let resultTurns = 0;
  let resultDurationMs = 0;
  let durationMs = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let denied = 0;
  let retries = 0;
  let validation: ValidationOutcome = "none";
  const filesChanged = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case "TurnStarted":
        turns = Math.max(turns, event.turn);
        break;
      case "FileChanged":
        filesChanged.add(event.path);
        break;
      case "ToolDenied":
        denied += 1;
        if (validation === "pending") {
          validation = "denied";
        }
        break;
      case "ApiRetry":
        retries += 1;
        break;
      case "ValidationStarted":
        validation = "pending";
        break;
      case "ValidationCompleted":
        validation = event.ok ? "ok" : "failed";
        break;
      case "RunCompleted":
        state = "COMPLETED";
        // A run can carry MORE THAN ONE result message: a child that hits
        // --max-turns and continues emits one per segment. Observed live on
        // 2026-09-20 — RunFailed(max_turns), then two RunCompleted — where
        // overwriting made a 21-minute, 64-turn run persist as "88s, 5 turns".
        // Each result describes only its own segment, so accumulate, and let
        // the derived turn count win when it is larger.
        resultTurns += event.turns;
        resultDurationMs += event.durationMs;
        tokensIn += event.tokensIn;
        tokensOut += event.tokensOut;
        break;
      case "RunFailed":
        state = "FAILED";
        break;
      case "RunCancelled":
        state = "CANCELLED";
        break;
      default:
        break;
    }
  }

  // The wall clock is the span of the stream; a sum of per-segment result
  // durations misses the gaps between them. Take whichever is larger so a
  // long run can never be reported as a short one.
  const span = events.length > 0
    ? Date.parse(events[events.length - 1].ts) - Date.parse(events[0].ts)
    : 0;
  durationMs = Math.max(resultDurationMs, Number.isFinite(span) && span > 0 ? span : 0);
  turns = Math.max(turns, resultTurns);

  return {
    id: events.length > 0 ? events[0].runId : "",
    state,
    turns,
    durationMs,
    filesChanged: [...filesChanged],
    tokensIn,
    tokensOut,
    denied,
    retries,
    validation,
  };
}

/**
 * The runtime check is deliberately just "parses and has a `type` string":
 * fully validating the union at runtime would duplicate the event model, and
 * a line that passes this check but carries wrong fields is history written
 * by a future version — dropping it would lose data forever.
 */
function isEventLike(value: unknown): value is WorkerEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
