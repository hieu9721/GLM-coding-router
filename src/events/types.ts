/**
 * The canonical v2 event model (specs/v2-architecture.md, Phase A).
 *
 * One discriminated union feeds every v2 consumer — run store, stderr
 * renderer, checkpoint builder, drain controller — so these shapes are the
 * contract the whole observability stack is built on. Types only: there is
 * deliberately no runtime code in this file.
 */

/**
 * Canonical, vendor-first provider id (v3 §1, decision D5). Persisted in
 * every event; "GLM" is display text only and never reaches a file.
 */
export type ProviderId = "zai.zcode";

/** v3's role axis. v2 only ever produces these two. */
export type AgentRole = "worker" | "reviewer";

/**
 * The six fields the event bus stamps on every event. Producers never set
 * them: a single authority for `seq` is what makes the stream orderable and
 * replayable from `events.jsonl` alone. `taskId` defaults to the `runId`
 * while there is no task graph (hedge H1), and the provider id is persisted
 * rather than the display name (hedge H2) so a v2-era history stays readable
 * by v3/v4 without a migration pass.
 */
export interface EventEnvelope {
  readonly runId: string;
  readonly taskId: string;
  readonly provider: ProviderId;
  readonly role: AgentRole;
  readonly seq: number;
  readonly ts: string;
}

/**
 * Opens the run record with everything the router knew before spawning.
 * `taskTitle`/`taskHash` identify the task without ever persisting the prompt
 * body (contract C3), and the estimator keys cost samples off `kind`/`model`.
 * `kind` names the CLI surface; the vendor id lives in the envelope (H2).
 */
export interface RunStarted extends EventEnvelope {
  readonly type: "RunStarted";
  readonly kind: "worker" | "review" | "delegate";
  readonly model: string;
  readonly cwd: string;
  readonly taskTitle: string;
  readonly taskHash: string;
  readonly parent: { readonly type: "claude" | "codex" | "shell" };
}

/**
 * Recorded once from the stream's `system/init`. `sessionId` is hedge H3: with
 * it, a future handoff can resume the Claude session instead of restarting the
 * task from scratch.
 */
export interface AgentInitialized extends EventEnvelope {
  readonly type: "AgentInitialized";
  readonly sessionId: string;
  readonly model: string;
  readonly tools: readonly string[];
}

/**
 * Marks the turn counter advancing. Turns are derived from the
 * tool_result → next tool_use cycle, not from assistant messages (A0 showed
 * one content block per message, which would roughly double every count).
 */
export interface TurnStarted extends EventEnvelope {
  readonly type: "TurnStarted";
  readonly turn: number;
}

/**
 * `summary` is the only tool detail allowed past the adapter boundary, so it
 * is short (≤120 chars) and redacted before it leaves (C3) — never a raw tool
 * input, never source code.
 */
export interface ToolStarted extends EventEnvelope {
  readonly type: "ToolStarted";
  readonly turn: number;
  readonly toolUseId: string;
  readonly tool: string;
  readonly summary: string;
}

/** Closes the cycle `ToolStarted` opened; `durationMs` feeds the p50/p90 cost estimates. */
export interface ToolCompleted extends EventEnvelope {
  readonly type: "ToolCompleted";
  readonly turn: number;
  readonly toolUseId: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly durationMs: number;
}

/**
 * Emitted only for Edit/Write that returned ok — this is what the checkpoint's
 * `filesChanged` and the handoff bundle's untracked-file list are built from.
 */
export interface FileChanged extends EventEnvelope {
  readonly type: "FileChanged";
  readonly turn: number;
  readonly path: string;
  readonly op: "edit" | "write";
}

/**
 * A Bash command from the validation allowlist started. Recorded separately
 * from `ToolStarted` so a checkpoint can name validations still owed even when
 * the tool event stream is all it has.
 */
export interface ValidationStarted extends EventEnvelope {
  readonly type: "ValidationStarted";
  readonly turn: number;
  readonly command: string;
}

/**
 * Pairs with `ValidationStarted`; `ok: false` leaves the run with a
 * `validationPending` entry in the checkpoint rather than a silent gap.
 */
export interface ValidationCompleted extends EventEnvelope {
  readonly type: "ValidationCompleted";
  readonly turn: number;
  readonly command: string;
  readonly ok: boolean;
  readonly durationMs: number;
}

/**
 * `system/permission_denied` is a first-class outcome, not an error (A0): a
 * denied tool is reportable in the summary even though nothing failed.
 */
export interface ToolDenied extends EventEnvelope {
  readonly type: "ToolDenied";
  readonly turn: number;
  readonly toolUseId: string;
  readonly tool: string;
  readonly reason: string;
}

/**
 * Parsed from Claude's stderr retry notices only — matched explicitly, because
 * the same channel carries structured diagnostics (e.g. `unrecognized_model`)
 * on perfectly successful runs that must not be classified as retries.
 */
export interface ApiRetry extends EventEnvelope {
  readonly type: "ApiRetry";
  readonly attempt?: number;
  readonly reason: string;
}

/**
 * Emitted when the budget zone degrades. The router observes and warns even
 * while its refusing/killing switches are off (decision D3) — this event is
 * how an unacted-upon near-miss stays visible in the run history.
 */
export interface BudgetWarning extends EventEnvelope {
  readonly type: "BudgetWarning";
  readonly zone: string;
  readonly remainingRatio: number;
  readonly usableBudget: number;
  readonly estimatedRemaining: number;
}

/**
 * A checkpoint was written to the run dir. `phase` is derived from the tool mix
 * of the last turn — the worker is never asked to summarize itself.
 */
export interface CheckpointCreated extends EventEnvelope {
  readonly type: "CheckpointCreated";
  readonly path: string;
  readonly phase: string;
}

/**
 * The router decided the task must return to the parent session (quota drain,
 * cancellation). Distinct from failure: handoff is an "unfinished, recoverable"
 * outcome with its own exit code.
 */
export interface HandoffStarted extends EventEnvelope {
  readonly type: "HandoffStarted";
  readonly reason: string;
}

/** The bundle exists on disk and `bundlePath` is where the parent session picks the work up. */
export interface HandoffCompleted extends EventEnvelope {
  readonly type: "HandoffCompleted";
  readonly reason: string;
  readonly bundlePath: string;
}

/**
 * Numbers come straight from the stream's `result` message rather than
 * tallying events (A0). `costCredits` is the quota delta — GLM bills in plan
 * credits, and the USD fields Claude computes for unknown models are fiction.
 */
export interface RunCompleted extends EventEnvelope {
  readonly type: "RunCompleted";
  readonly turns: number;
  readonly durationMs: number;
  readonly filesChanged: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costCredits?: number;
}

/** Terminal error: `reason` classifies (`error_max_turns` | `child_error` | …), `exitCode` preserves the v1 mapping. */
export interface RunFailed extends EventEnvelope {
  readonly type: "RunFailed";
  readonly reason: string;
  readonly exitCode: number;
}

/**
 * A forwarded signal (Ctrl+C must reach the child). Kept apart from
 * `RunFailed` so `runs` can tell "the human stopped it" from "it broke".
 */
export interface RunCancelled extends EventEnvelope {
  readonly type: "RunCancelled";
  readonly signal: string;
}

/**
 * Liveness signal (fed by the throttled `thinking_tokens` counter). This is
 * what lets `watch` and orphan detection tell a live run from a hung one —
 * `claude -p` text mode emits nothing until it finishes.
 */
export interface Heartbeat extends EventEnvelope {
  readonly type: "Heartbeat";
  readonly state: string;
  readonly turn: number;
}

/**
 * Every event the bus can dispatch, discriminated on `type`. Consumers narrow
 * with a `switch` so adding an event is a compile error wherever it is
 * unhandled.
 */
export type WorkerEvent =
  | RunStarted
  | AgentInitialized
  | TurnStarted
  | ToolStarted
  | ToolCompleted
  | FileChanged
  | ValidationStarted
  | ValidationCompleted
  | ToolDenied
  | ApiRetry
  | BudgetWarning
  | CheckpointCreated
  | HandoffStarted
  | HandoffCompleted
  | RunCompleted
  | RunFailed
  | RunCancelled
  | Heartbeat;

/** Every event name, for consumers that filter or route on `type` as a value. */
export type WorkerEventType = WorkerEvent["type"];
