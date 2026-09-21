import path from "node:path";
import { logger } from "../core/logging.js";
import { atomicWriteFile } from "../project/atomic-write.js";
import type { WorkerEvent } from "../events/types.js";

/** Doc §16's shape, rebuilt from events only (doc §17). */
export const CHECKPOINT_FILE_NAME = "checkpoint.json";

/** Tools whose appearance in a turn marks that turn as implementation work. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** C3: the widest any human-readable checkpoint line may ever be. */
const LINE_MAX_CHARS = 120;

/** Doc §16. `phase` names the last thing the worker was actually doing. */
export type CheckpointPhase = "exploration" | "implementation" | "validation";

/**
 * Doc §16's `checkpoint.json` shape. Every field is derived from the event
 * stream alone — the worker is never asked to write its own summary (doc §17),
 * because a worker that dies mid-run is exactly the worker whose summary you
 * need and the one that never wrote one.
 */
export interface Checkpoint {
  readonly runId: string;
  readonly phase: CheckpointPhase;
  readonly completed: readonly string[];
  readonly pending: readonly string[];
  readonly filesChanged: readonly string[];
  readonly validationPending: readonly string[];
}

/**
 * Per-turn evidence, accumulated in one pass. Only what the checkpoint needs:
 * tool summaries (already redacted and capped by the adapter, C3), validation
 * tallies, and whether the turn showed edit-class activity. Mutable arrays on
 * purpose — this is internal scratch state, not a persisted shape.
 */
interface TurnState {
  /** `"Edit src/a.ts"` per `ToolStarted`, in emission order. */
  readonly toolLines: string[];
  /** Validation commands started in this turn (a command may repeat). */
  readonly validationStarts: string[];
  /** Validation commands completed with `ok: true` in this turn. */
  readonly validationOk: string[];
  /** Validation commands completed with `ok: false` in this turn. */
  readonly validationFailed: string[];
  /** Any Edit/Write/MultiEdit `ToolStarted`/`ToolCompleted`, or a `FileChanged`. */
  hasEditTool: boolean;
}

/**
 * Rebuilds a checkpoint from an event stream — the pure half of Phase F. Never
 * throws and never reads a prompt: every string it returns is either a
 * redacted tool summary (the adapter already enforced C3) or the redacted,
 * 120-char `taskTitle` the `RunStarted` event already persisted.
 *
 * `pending` is the C3-safe reading of a spec that contradicted itself: Phase F
 * first says it is "derived from the prompt's checklist lines if present", then
 * that the checkpoint is "rebuilt from events only". Both cannot hold, and the
 * first would put prompt text into `checkpoint.json` under `<configDir>/runs/`,
 * which the C3 sweep walks. Events win:
 *
 * - with a `RunStarted`: the run's `taskTitle`, plus one entry per validation
 *   still owed (`validationPending`);
 * - without one: the single entry `"continue the task"`.
 *
 * Do not "restore" prompt parsing here — if a richer pending list is ever
 * wanted, the event model is where it must arrive (e.g. a task-spec event), not
 * the prompt body.
 */
export function buildCheckpoint(events: readonly WorkerEvent[]): Checkpoint {
  let taskTitle: string | undefined;
  let lastTurnStarted = 0;
  let lastToolTurn = 0;
  let terminalSeen = false;
  const turns = new Map<number, TurnState>();
  const filesChanged: string[] = [];
  const seenFiles = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case "RunStarted":
        // First wins: a multi-segment run (error_max_turns + continue) replays
        // its opener, and the original title is the one the registry recorded.
        if (taskTitle === undefined) {
          taskTitle = event.taskTitle;
        }
        break;
      case "TurnStarted":
        lastTurnStarted = Math.max(lastTurnStarted, event.turn);
        break;
      case "ToolStarted": {
        const state = turnState(turns, event.turn);
        state.toolLines.push(`${event.tool} ${event.summary}`);
        if (EDIT_TOOLS.has(event.tool)) {
          state.hasEditTool = true;
        }
        lastToolTurn = Math.max(lastToolTurn, event.turn);
        break;
      }
      case "ToolCompleted": {
        const state = turnState(turns, event.turn);
        // The completion alone is enough evidence of an edit: a stream whose
        // `ToolStarted` line was lost to a crash still classifies truthfully.
        if (EDIT_TOOLS.has(event.tool)) {
          state.hasEditTool = true;
        }
        lastToolTurn = Math.max(lastToolTurn, event.turn);
        break;
      }
      case "FileChanged":
        turnState(turns, event.turn).hasEditTool = true;
        lastToolTurn = Math.max(lastToolTurn, event.turn);
        if (!seenFiles.has(event.path)) {
          seenFiles.add(event.path);
          filesChanged.push(event.path);
        }
        break;
      case "ValidationStarted":
        turnState(turns, event.turn).validationStarts.push(event.command);
        lastToolTurn = Math.max(lastToolTurn, event.turn);
        break;
      case "ValidationCompleted": {
        const state = turnState(turns, event.turn);
        (event.ok ? state.validationOk : state.validationFailed).push(event.command);
        lastToolTurn = Math.max(lastToolTurn, event.turn);
        break;
      }
      case "ToolDenied":
        // A denied tool ran nothing, so it proves neither edits nor validation;
        // its ToolStarted summary is already in toolLines (A0: reportable).
        lastToolTurn = Math.max(lastToolTurn, event.turn);
        break;
      case "RunCompleted":
      case "RunFailed":
      case "RunCancelled":
        terminalSeen = true;
        break;
      default:
        break;
    }
  }

  const ordered = [...turns.entries()].sort((a, b) => a[0] - b[0]);

  // Phase comes from the LAST turn with tool activity — a TurnStarted alone is
  // a counter, not activity, so a stream truncated right after one keeps the
  // phase of the turn that was actually doing something.
  const lastActive = lastToolTurn > 0 ? turns.get(lastToolTurn) : undefined;
  const phase: CheckpointPhase =
    lastActive !== undefined && lastActive.validationStarts.length > 0
      ? "validation"
      : lastActive !== undefined && lastActive.hasEditTool
        ? "implementation"
        : "exploration";

  const completed: string[] = [];
  for (const [turn, state] of ordered) {
    // Finished = a later turn started, or the run reached a terminal event.
    // The final turn of a stream with no terminal event is the one in progress
    // when the handoff happened, so it stays out of `completed`.
    if (state.toolLines.length > 0 && (turn < lastTurnStarted || terminalSeen)) {
      completed.push(`turn ${turn}: ${state.toolLines.join(", ")}`.slice(0, LINE_MAX_CHARS));
    }
  }

  const validationPending = owedValidations(ordered);

  const pending =
    taskTitle === undefined
      ? // No RunStarted at all: the stream lost its opener (or is empty), so
        // there is no title to carry — one honest entry, nothing fabricated.
        ["continue the task"]
      : [taskTitle.trim().length > 0 ? taskTitle : "continue the task", ...validationPending];

  return {
    // Mirrors summarize(): the first event's runId is the run the stream
    // belongs to, and "" is the only answer an empty stream has.
    runId: events.length > 0 ? events[0].runId : "",
    phase,
    completed,
    pending,
    filesChanged,
    validationPending,
  };
}

/**
 * Writes `checkpoint.json` into a run directory and returns its path, or null
 * on any failure — logged at debug, never thrown. A checkpoint is an aid: the
 * run it describes has already happened, and losing the aid must not cost the
 * run its exit path.
 */
export function writeCheckpoint(runDirPath: string, checkpoint: Checkpoint): string | null {
  const file = path.join(runDirPath, CHECKPOINT_FILE_NAME);
  try {
    atomicWriteFile(file, JSON.stringify(checkpoint, null, 2) + "\n");
    return file;
  } catch (error) {
    logger.debug(`writeCheckpoint: writing ${file} failed: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Validations still owed: every started command with no ok completion in the
 * SAME turn (the adapter ties a completion to the turn that started it), plus
 * every completion that reported `ok: false`. A denied validation falls under
 * the first clause — the denial never produces a completion, and A0 settled
 * that a denied validation is a real, reportable outcome rather than an error,
 * so it must resurface here instead of vanishing. Deduplicated by command,
 * first-owed order: the reader wants which commands to run, not how many times
 * the run failed to run them.
 */
function owedValidations(orderedTurns: readonly [number, TurnState][]): string[] {
  const owed: string[] = [];
  const seen = new Set<string>();
  const add = (command: string): void => {
    if (!seen.has(command)) {
      seen.add(command);
      owed.push(command);
    }
  };

  for (const [, state] of orderedTurns) {
    for (const command of new Set(state.validationStarts)) {
      if (occurrences(state.validationOk, command) < occurrences(state.validationStarts, command)) {
        add(command);
      }
    }
    for (const command of state.validationFailed) {
      add(command);
    }
  }
  return owed;
}

function turnState(turns: Map<number, TurnState>, turn: number): TurnState {
  let state = turns.get(turn);
  if (state === undefined) {
    state = { toolLines: [], validationStarts: [], validationOk: [], validationFailed: [], hasEditTool: false };
    turns.set(turn, state);
  }
  return state;
}

function occurrences(commands: readonly string[], command: string): number {
  let count = 0;
  for (const entry of commands) {
    if (entry === command) {
      count += 1;
    }
  }
  return count;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
