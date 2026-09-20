import { logger, redact } from "../core/logging.js";
import type { EventInput } from "./bus.js";

/**
 * Claude Code `--output-format stream-json` adapter (specs/v2-architecture.md,
 * Phase A).
 *
 * Maps NDJSON stdout lines — and retry-looking stderr lines — onto the
 * canonical event model as UNSTAMPED `EventInput[]`: the bus is the only
 * authority for `runId`/`taskId`/`provider`/`role`/`seq`/`ts`, so a producer
 * physically cannot forge a sequence number.
 *
 * The stream-json schema is not a stable public API (A0), so the mapper is
 * defensive by construction: any unrecognized `type`, missing field or wrong
 * shape yields zero events plus one debug log — never a throw. A malformed
 * line must not kill a run; that is the single most important property of
 * this file, and even an adapter bug degrades the same way (see the
 * try/catch in {@link adaptClaudeMessage}).
 */

/** The only tool detail allowed past this boundary (contract C3). */
const SUMMARY_MAX_CHARS = 120;

/**
 * 83–88% of stream lines are `thinking_tokens` counters (A0). One Heartbeat
 * per second is the cap that keeps `events.jsonl` from being ~85% counter
 * spam while still proving the run is alive.
 */
const HEARTBEAT_MIN_INTERVAL_MS = 1000;

/** Validation allowlist, exact from the spec (Phase A). */
const VALIDATION_COMMAND =
  /(npm|pnpm|yarn) (run )?(test|lint|typecheck)|vitest|jest|go test|pytest|cargo test|tsc\b|python3? (-m (pytest|unittest)\b|\S*test\S*\.py)/;

/** Tools whose ok completion changes a file, and therefore emits `FileChanged`. */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * Matched explicitly, never loosely: stderr also carries structured
 * diagnostics such as `[claude-code:unrecognized_model] {"model":…}` on
 * perfectly successful runs, and classifying those as retries would corrupt
 * the retry counters the estimator feeds on (A0).
 */
const RETRY_LINE =
  /\bretr(?:y|ying|ies)\b|\brate[ _-]?limit|\boverload|too many requests|service unavailable|api error:?\s*\b(?:429|500|502|503|504|529)\b/i;

/**
 * The adapter is I/O-free, so it has no secret list of its own to strip.
 * Summaries still pass through `redact()` so the boundary exists here — when
 * the spawn path (Phase D) can thread real secrets in, this is the one place
 * they apply.
 */
const NO_SECRETS: readonly string[] = [];

/** Mutable per-run state threaded through the pure mapper. */
export interface AdapterState {
  /** Current turn, starts at 0 (advanced by the tool_result → tool_use cycle). */
  turn: number;
  /** Recorded once from `system/init` (hedge H3); later repeats are ignored. */
  sessionId?: string;
  /** Open tool cycles, keyed by `tool_use_id`. */
  pending: Map<string, PendingTool>;
  /** Timestamp of the last emitted Heartbeat, for throttling. */
  lastHeartbeatMs: number;
  /** The spawn cwd, used to make file paths repo-relative. */
  cwd: string;
  /**
   * Turn-derivation flag: set when a `tool_result` arrives, cleared when a
   * `tool_use` opens a new turn. Not in the packet's state sketch, but its
   * turn rule ("first tool_use after a tool_result") cannot be implemented
   * without it, and state is the only place a pure mapper can keep it.
   */
  sawResultSinceLastToolUse: boolean;
  /**
   * Distinct `FileChanged` paths, so `RunCompleted.filesChanged` counts what
   * was actually emitted rather than re-deriving it from events the adapter
   * has already handed away.
   */
  filesChanged: Set<string>;
}

/** An open tool cycle: enough to close it later without keeping raw tool input (C3). */
export interface PendingTool {
  readonly tool: string;
  readonly summary: string;
  readonly startedMs: number;
  readonly isValidation: boolean;
  readonly turn: number;
}

export function createAdapterState(cwd: string): AdapterState {
  return {
    turn: 0,
    pending: new Map(),
    // 0 means "never beaten": any wall clock is already past it, so the first
    // counter line of a run establishes liveness immediately.
    lastHeartbeatMs: 0,
    cwd,
    sawResultSinceLastToolUse: false,
    filesChanged: new Set(),
  };
}

/**
 * Pure: same input + state produces the same events. Mutates `state` (that is
 * its job — pending tools, turn counter, heartbeat throttle), but touches no
 * clock, file or network besides the injected `now`.
 */
export function adaptClaudeMessage(
  raw: unknown,
  state: AdapterState,
  now?: () => number,
): EventInput[] {
  try {
    return mapMessage(raw, state, now ?? Date.now);
  } catch (error) {
    // The mappers below already shape-check everything; this catch is for
    // adapter bugs, so the "malformed line must not kill a run" property
    // holds even when the bug is ours.
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`claude-adapter: dropping message that failed to map: ${message}`);
    return [];
  }
}

/** Hedge H8: the interface a second provider adapter will implement. */
export interface EventAdapter {
  onStdoutLine(line: string): EventInput[];
  onStderrLine(line: string): EventInput[];
}

/**
 * Wraps the pure mapper with NDJSON line buffering (partial chunks, `\r\n`,
 * blank lines) and the stderr retry sink. One adapter instance per run: the
 * buffered tail and the state it carries are per-stream.
 */
export function createStreamAdapter(
  cwd: string,
  deps?: { now?: () => number },
): EventAdapter & { onStdoutChunk(chunk: string): EventInput[] } {
  const state = createAdapterState(cwd);
  const now = deps?.now;
  let buffered = "";

  const consumeLine = (line: string): EventInput[] => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (trimmed === "") {
      return [];
    }
    try {
      return adaptClaudeMessage(JSON.parse(trimmed), state, now);
    } catch {
      logger.debug("claude-adapter: stdout line is not valid JSON");
      return [];
    }
  };

  return {
    onStdoutLine(line) {
      return consumeLine(line);
    },
    // Only `\n`-terminated lines are consumed — the `\r` of a `\r\n` pair
    // rides along in the line and is stripped — so a JSON object split
    // across two chunks still parses exactly once, when complete.
    onStdoutChunk(chunk) {
      buffered += chunk;
      const events: EventInput[] = [];
      let newlineAt = buffered.indexOf("\n");
      while (newlineAt >= 0) {
        const line = buffered.slice(0, newlineAt);
        buffered = buffered.slice(newlineAt + 1);
        events.push(...consumeLine(line));
        newlineAt = buffered.indexOf("\n");
      }
      return events;
    },
    onStderrLine(line) {
      return mapStderrLine(line);
    },
  };
}

function mapMessage(raw: unknown, state: AdapterState, now: () => number): EventInput[] {
  if (!isRecord(raw)) {
    logger.debug("claude-adapter: ignoring non-object stream line");
    return [];
  }
  switch (raw.type) {
    case "system":
      return mapSystemMessage(raw, state, now);
    case "assistant":
      return mapAssistantMessage(raw, state, now);
    case "user":
      return mapUserMessage(raw, state, now);
    case "result":
      return mapResultMessage(raw, state);
    default:
      logger.debug(`claude-adapter: unrecognized stream message type ${JSON.stringify(raw.type)}`);
      return [];
  }
}

function mapSystemMessage(
  raw: Record<string, unknown>,
  state: AdapterState,
  now: () => number,
): EventInput[] {
  switch (raw.subtype) {
    case "init":
      return mapInit(raw, state);
    case "thinking_tokens":
      return mapThinkingTokens(state, now);
    case "permission_denied":
      return mapPermissionDenied(raw, state);
    // User hooks fire inside the stream (A0); they are neither tool activity
    // nor errors, so they are recognized and dropped without a log line.
    case "hook_started":
    case "hook_response":
      return [];
    default:
      logger.debug(`claude-adapter: unrecognized system subtype ${JSON.stringify(raw.subtype)}`);
      return [];
  }
}

function mapInit(raw: Record<string, unknown>, state: AdapterState): EventInput[] {
  const sessionId = asString(raw.session_id);
  const model = asString(raw.model);
  if (sessionId === undefined || model === undefined) {
    logger.debug("claude-adapter: system/init missing session_id or model");
    return [];
  }
  state.sessionId = sessionId;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  return [{ type: "AgentInitialized", sessionId, model, tools }];
}

function mapThinkingTokens(state: AdapterState, now: () => number): EventInput[] {
  const at = now();
  if (at - state.lastHeartbeatMs < HEARTBEAT_MIN_INTERVAL_MS) {
    return [];
  }
  state.lastHeartbeatMs = at;
  return [{ type: "Heartbeat", state: "working", turn: state.turn }];
}

function mapPermissionDenied(raw: Record<string, unknown>, state: AdapterState): EventInput[] {
  const toolUseId = asString(raw.tool_use_id);
  const tool = asString(raw.tool_name);
  const reason = asString(raw.decision_reason) ?? asString(raw.message);
  if (toolUseId === undefined || tool === undefined || reason === undefined) {
    logger.debug("claude-adapter: system/permission_denied missing tool_use_id, tool_name or reason");
    return [];
  }
  // The denied tool never ran: drop the pending entry so the error
  // tool_result that follows maps to nothing instead of a bogus ToolCompleted.
  state.pending.delete(toolUseId);
  return [{ type: "ToolDenied", turn: state.turn, toolUseId, tool, reason: sanitize(reason) }];
}

function mapAssistantMessage(
  raw: Record<string, unknown>,
  state: AdapterState,
  now: () => number,
): EventInput[] {
  const message = raw.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    logger.debug("claude-adapter: assistant message without a content array");
    return [];
  }
  const events: EventInput[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) {
      continue;
    }
    switch (block.type) {
      // Raw model reasoning: dropped at the boundary, never summarized,
      // never persisted (contract C3, A0).
      case "thinking":
        break;
      // Final answer text is the spawn path's business (stdout, contract C1);
      // no event ever carries an LLM response body.
      case "text":
        break;
      case "tool_use":
        events.push(...mapToolUse(block, state, now));
        break;
      default:
        logger.debug(`claude-adapter: unrecognized assistant content block ${JSON.stringify(block.type)}`);
        break;
    }
  }
  return events;
}

function mapToolUse(
  block: Record<string, unknown>,
  state: AdapterState,
  now: () => number,
): EventInput[] {
  const toolUseId = asString(block.id);
  const tool = asString(block.name);
  if (toolUseId === undefined || tool === undefined) {
    logger.debug("claude-adapter: tool_use block without id or name");
    return [];
  }
  const input = isRecord(block.input) ? block.input : {};
  const command = asString(input.command);
  const summary = summarizeToolUse(tool, input, state.cwd);
  const isValidation = tool === "Bash" && command !== undefined && VALIDATION_COMMAND.test(command);
  const events: EventInput[] = [];

  // Turn derivation (A0): one turn per tool_result → next tool_use cycle.
  // A TurnStarted per assistant message would roughly double every count,
  // because the stream emits thinking / tool_use / text as separate messages.
  if (state.turn === 0 || state.sawResultSinceLastToolUse) {
    state.turn += 1;
    state.sawResultSinceLastToolUse = false;
    events.push({ type: "TurnStarted", turn: state.turn });
  }
  if (isValidation) {
    events.push({ type: "ValidationStarted", turn: state.turn, command: summary });
  }
  events.push({ type: "ToolStarted", turn: state.turn, toolUseId, tool, summary });
  state.pending.set(toolUseId, { tool, summary, startedMs: now(), isValidation, turn: state.turn });
  return events;
}

function mapUserMessage(
  raw: Record<string, unknown>,
  state: AdapterState,
  now: () => number,
): EventInput[] {
  const message = raw.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    logger.debug("claude-adapter: user message without a content array");
    return [];
  }
  const events: EventInput[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_result") {
      continue;
    }
    // Any tool_result closes a turn's tool cycle — even one with no matching
    // pending entry — so the next tool_use still opens a new turn.
    state.sawResultSinceLastToolUse = true;
    events.push(...mapToolResult(block, state, now));
  }
  return events;
}

function mapToolResult(
  block: Record<string, unknown>,
  state: AdapterState,
  now: () => number,
): EventInput[] {
  const toolUseId = asString(block.tool_use_id);
  if (toolUseId === undefined) {
    logger.debug("claude-adapter: tool_result block without tool_use_id");
    return [];
  }
  const pending = state.pending.get(toolUseId);
  if (pending === undefined) {
    // Expected right after a permission_denied dropped the entry, or on
    // schema drift; either way there is nothing truthful to report.
    logger.debug(`claude-adapter: tool_result for unknown tool_use_id ${toolUseId}`);
    return [];
  }
  state.pending.delete(toolUseId);
  const ok = block.is_error !== true;
  const durationMs = Math.max(0, now() - pending.startedMs);
  const events: EventInput[] = [
    { type: "ToolCompleted", turn: pending.turn, toolUseId, tool: pending.tool, ok, durationMs },
  ];
  if (pending.isValidation) {
    events.push({ type: "ValidationCompleted", turn: pending.turn, command: pending.summary, ok, durationMs });
  }
  if (ok && FILE_TOOLS.has(pending.tool)) {
    // The summary for these tools *is* the repo-relative path, which is why
    // PendingTool needs no copy of the raw input (C3).
    events.push({
      type: "FileChanged",
      turn: pending.turn,
      path: pending.summary,
      op: pending.tool === "Write" ? "write" : "edit",
    });
    state.filesChanged.add(pending.summary);
  }
  return events;
}

function mapResultMessage(raw: Record<string, unknown>, state: AdapterState): EventInput[] {
  if (raw.subtype === "success") {
    const turns = asFiniteNumber(raw.num_turns);
    const durationMs = asFiniteNumber(raw.duration_ms);
    if (turns === undefined || durationMs === undefined) {
      logger.debug("claude-adapter: success result missing num_turns or duration_ms");
      return [];
    }
    const usage = isRecord(raw.usage) ? raw.usage : {};
    // Token counts are real (they come from the API response).
    // `total_cost_usd` / `modelUsage[].costUSD` are deliberately never read:
    // Claude Code computes them with Anthropic's price table for a model it
    // does not know, so for this stack they are fiction (A0). GLM bills in
    // plan credits; the quota delta stays the only cost truth.
    return [
      {
        type: "RunCompleted",
        turns,
        durationMs,
        filesChanged: state.filesChanged.size,
        tokensIn: asFiniteNumber(usage.input_tokens) ?? 0,
        tokensOut: asFiniteNumber(usage.output_tokens) ?? 0,
      },
    ];
  }
  return [
    {
      type: "RunFailed",
      reason: sanitize(asString(raw.terminal_reason) ?? asString(raw.subtype) ?? "unknown"),
      exitCode: 1,
    },
  ];
}

function mapStderrLine(line: string): EventInput[] {
  const trimmed = line.trim();
  if (trimmed === "" || !RETRY_LINE.test(trimmed)) {
    // Everything else is a passthrough diagnostic for the spawn path to
    // forward, not an event.
    return [];
  }
  const attempt = /\battempt (\d+)\b/i.exec(trimmed);
  return attempt === null
    ? [{ type: "ApiRetry", reason: sanitize(trimmed) }]
    : [{ type: "ApiRetry", attempt: Number(attempt[1]), reason: sanitize(trimmed) }];
}

function summarizeToolUse(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): string {
  let text: string;
  switch (tool) {
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit": {
      const filePath = asString(input.file_path);
      text = filePath === undefined ? tool : toRepoRelative(filePath, cwd);
      break;
    }
    case "Bash": {
      const command = asString(input.command);
      text = command === undefined ? tool : firstLine(command);
      break;
    }
    case "Grep":
    case "Glob": {
      const pattern = asString(input.pattern);
      text = pattern === undefined ? tool : pattern;
      break;
    }
    default:
      text = tool;
  }
  return sanitize(text);
}

/**
 * Repo-relative when the path is under the cwd, untouched otherwise. A plain
 * prefix check rather than `path.relative`, so the POSIX paths in the
 * captured fixtures and Windows paths on a live run behave identically and
 * the adapter stays platform-free.
 */
function toRepoRelative(filePath: string, cwd: string): string {
  for (const sep of ["/", "\\"]) {
    const prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
    if (filePath.startsWith(prefix)) {
      return filePath.slice(prefix.length);
    }
  }
  return filePath;
}

function firstLine(command: string): string {
  return command.split(/\r?\n/)[0];
}

/** Every user-facing string from the adapter is redacted and short (C3). */
function sanitize(text: string): string {
  return redact(text, NO_SECRETS).slice(0, SUMMARY_MAX_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
