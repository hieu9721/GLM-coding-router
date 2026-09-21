import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../core/config.js";
import { Errors, ExitCode } from "../core/errors.js";
import { logger } from "../core/logging.js";
import { activeRunFile, runDir } from "../core/paths.js";
import type { RunStarted, WorkerEvent } from "../events/types.js";
import {
  finishRun,
  isOrphaned,
  listActive,
  listHistory,
  pruneHistory,
  type ActiveRun,
  type RunSummaryRef,
} from "../runs/registry.js";
import { eventsFilePath, readEvents, summarize } from "../runs/store.js";
import type { RunSummary } from "../runs/store.js";
import { emitJson, type GlobalOptions } from "./context.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A table is a summary view; the 20 newest runs fit a screen and a question. */
const DEFAULT_LIMIT = 20;

/**
 * Matches the rich progress renderer's tool column width so a replayed tree and
 * the live view print identical lines — the two views must not drift apart.
 */
const TOOL_COLUMN_WIDTH = 5;

/**
 * Injected environment for every `runs` subcommand. Tests pass a temp home (the
 * real `~/.glm-coding-router` is never touched), a fixed clock (deterministic
 * durations) and a liveness stub (orphan reaping never probes a real pid).
 */
export interface RunsDeps {
  readonly home?: string;
  readonly now?: () => Date;
  readonly isAlive?: (pid: number) => boolean;
}

export interface RunsListOptions {
  readonly active?: boolean;
  readonly limit?: number;
}

export interface RunsCleanOptions {
  readonly olderThan?: string;
  readonly orphans?: boolean;
}

/** Everything one list row carries; the table shortens, `--json` keeps full values. */
interface RunRow {
  readonly id: string;
  readonly date: string;
  readonly state: string;
  readonly kind: string | null;
  readonly model: string | null;
  readonly startedAt: string | null;
  readonly durationMs: number | null;
  readonly turns: number | null;
  readonly files: number | null;
  readonly cwd: string | null;
  /**
   * Carried in `--json` only — it has no table column, but it is the reason
   * the spec's own validation step reads this command:
   * `runs --json | jq '[.[] | select(.routingAdvice.wouldRefuse)] | length'`
   * is how 2.1 decides whether refuseOnCritical can be flipped on (D3).
   */
  readonly routingAdvice: RunSummary["routingAdvice"] | null;
}

const TABLE_HEADERS = ["id", "state", "kind", "model", "started", "duration", "turns", "files", "cwd"];

/**
 * glm-router runs — the readable face of the history Phase B records. Exit 0
 * even with an empty history: having no runs yet is a normal state, not an
 * error, so the command never trains users to ignore its exit code.
 */
export function runsCommand(options: GlobalOptions & RunsListOptions, deps: RunsDeps = {}): number {
  const home = deps.home ?? os.homedir();
  const now = deps.now ?? (() => new Date());
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw Errors.invalidArgs(`--limit expects a positive integer, got "${String(options.limit)}"`);
  }

  const rows: RunRow[] = options.active ? activeRows(home, now, limit) : historyRows(home, limit);

  if (options.json) {
    // RunRow already IS the machine shape: full ids, full cwd paths, nulls
    // where the table shows a placeholder.
    emitJson(rows);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write(options.active ? "no active runs\n" : "no runs recorded yet\n");
    return 0;
  }
  process.stdout.write(renderTable(TABLE_HEADERS, rows.map(rowToCells)) + "\n");
  return 0;
}

/**
 * History rows: the registry's refs plus the model/cwd only `events.jsonl`
 * knows. A run that is still going appears here too — its directory exists
 * from the first event — and would read as CRASHED, because its stream has
 * no terminal event yet. The active file is the live truth, so its state
 * overrides the derived one.
 */
function historyRows(home: string, limit: number): RunRow[] {
  const live = new Map(listActive(home).map((run) => [run.id, run.state]));
  return listHistory(home)
    .slice(0, limit)
    .map((ref) => {
      const start = readRunStartInfo(runDir(home, ref.date, ref.id));
      return {
        id: ref.id,
        date: ref.date,
        state: live.get(ref.id) ?? ref.state,
        kind: ref.kind,
        model: start.model,
        startedAt: ref.startedAt,
        durationMs: ref.summary?.durationMs ?? null,
        turns: ref.summary?.turns ?? null,
        files: ref.summary?.filesChanged.length ?? null,
        routingAdvice: ref.summary?.routingAdvice ?? null,
        cwd: start.cwd,
      };
    });
}

/** Active rows: state from the active file, counters rebuilt from the stream so far. */
function activeRows(home: string, now: () => Date, limit: number): RunRow[] {
  return listActive(home)
    .slice(0, limit)
    .map((run) => {
      const dir = runDir(home, run.date, run.id);
      // The active registry entry deliberately carries no counters — turns and
      // files are whatever the run has written so far, rebuilt from events.
      const events = readEvents(dir);
      const progress = events.length > 0 ? summarize(events) : null;
      return {
        id: run.id,
        date: run.date,
        state: run.state,
        kind: run.kind,
        model: run.model,
        startedAt: run.startedAt,
        durationMs: elapsedSince(run.startedAt, now),
        turns: progress?.turns ?? null,
        files: progress?.filesChanged.length ?? null,
        routingAdvice: null, // a live run has no summary yet
        cwd: run.cwd,
      };
    });
}

function rowToCells(row: RunRow): string[] {
  return [
    row.id.slice(-6),
    row.state,
    row.kind ?? "—",
    row.model ?? "—",
    row.startedAt !== null ? formatLocalTime(row.startedAt) : "—",
    row.durationMs !== null ? formatDuration(row.durationMs) : "—",
    row.turns !== null ? String(row.turns) : "—",
    row.files !== null ? String(row.files) : "—",
    row.cwd !== null ? path.basename(row.cwd) || row.cwd : "—",
  ];
}

/**
 * glm-router runs show <id> — metadata, summary numbers and the per-turn tool
 * tree of one run. The id may be a unique suffix so the short id from the table
 * can be pasted straight back in. This is the command a crashed run exists for:
 * when `summary.json` is missing the numbers are rebuilt from `events.jsonl`.
 */
export function runsShowCommand(id: string, options: GlobalOptions, deps: RunsDeps = {}): number {
  const home = deps.home ?? os.homedir();
  const now = deps.now ?? (() => new Date());
  const run = resolveRun(home, id);
  const events = readEvents(run.dir);
  const started = events.find((event): event is RunStarted => event.type === "RunStarted") ?? null;

  // summary.json is authoritative (A0: its numbers come from the result
  // message); rebuilding from events is the crashed-run fallback.
  const summary: RunSummary | null = run.ref?.summary ?? (events.length > 0 ? summarize(events) : null);
  const state = run.active?.state ?? run.ref?.state ?? "CRASHED";
  const kind = started?.kind ?? run.active?.kind ?? run.ref?.kind ?? null;
  const role = started?.role ?? run.active?.role ?? null;
  const model = started?.model ?? run.active?.model ?? null;
  const provider = started?.provider ?? run.active?.provider ?? null;
  const cwd = started?.cwd ?? run.active?.cwd ?? null;
  const startedAt = started?.ts ?? run.active?.startedAt ?? run.ref?.startedAt ?? null;
  const taskTitle = started?.taskTitle ?? run.active?.taskTitle ?? null;
  // A live run's duration keeps growing; a finished run's is whatever it recorded.
  const durationMs = run.active !== null ? elapsedSince(run.active.startedAt, now) : summary?.durationMs ?? null;

  // Phase F writes checkpoint.json; before it lands, absence is the normal case
  // and must render as nothing rather than a gap.
  const checkpoint = fs.existsSync(path.join(run.dir, "checkpoint.json"))
    ? path.join(run.dir, "checkpoint.json")
    : null;

  if (options.json) {
    emitJson({
      id: run.id,
      kind,
      role,
      state,
      model,
      provider,
      cwd,
      startedAt,
      durationMs,
      taskTitle,
      checkpoint,
      summary,
      turns: buildTurnTree(events),
    });
    return 0;
  }

  const meta: [string, string][] = [
    ["Run", run.id],
    ["Kind", kind !== null ? (role !== null ? `${kind} (role: ${role})` : kind) : "—"],
    ["State", state],
    ["Model", model ?? "—"],
    ["Provider", provider ?? "—"],
    ["Cwd", cwd ?? "—"],
    ["Started", startedAt !== null ? formatLocalTime(startedAt) : "—"],
    ["Duration", durationMs !== null ? formatDuration(durationMs) : "—"],
    ["Task", taskTitle ?? "—"],
  ];
  if (checkpoint !== null) {
    meta.push(["Checkpoint", checkpoint]);
  }
  const metaWidth = Math.max(...meta.map(([label]) => label.length)) + 2;

  const lines: string[] = [];
  for (const [label, value] of meta) {
    lines.push(`${label.padEnd(metaWidth)}${value}`);
  }

  lines.push("", "Summary");
  if (summary === null) {
    lines.push("  (no summary.json and no readable events — nothing to rebuild from)");
  } else {
    const numbers: [string, string][] = [
      ["Turns", String(summary.turns)],
      ["Files changed", String(summary.filesChanged.length)],
      ["Tokens in", String(summary.tokensIn)],
      ["Tokens out", String(summary.tokensOut)],
      ["Denials", String(summary.denied)],
      ["Retries", String(summary.retries)],
      ["Validation", summary.validation],
    ];
    const numberWidth = Math.max(...numbers.map(([label]) => label.length)) + 2;
    for (const [label, value] of numbers) {
      lines.push(`  ${label.padEnd(numberWidth)}${value}`);
    }
  }

  const tree = buildTurnTree(events);
  lines.push("");
  if (tree.length === 0) {
    lines.push("(no tool activity recorded)");
  }
  for (const block of tree) {
    lines.push(`◉ Turn ${block.turn}`);
    block.entries.forEach((entry, index) => {
      lines.push(`  ${index === block.entries.length - 1 ? "└─" : "├─"} ${entry}`);
    });
  }
  lines.push("", run.active !== null ? `● ${run.active.state} — run is still active` : terminalLine(events));
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

/**
 * glm-router runs logs <id> — `events.jsonl`, one rendered line per event.
 * `--json` prints the raw lines unchanged so the output pipes straight into
 * jq. No `--follow` here: following is `runs watch`, a different rendering.
 */
export function runsLogsCommand(id: string, options: GlobalOptions, deps: RunsDeps = {}): number {
  const home = deps.home ?? os.homedir();
  const run = resolveRun(home, id);
  const file = eventsFilePath(run.dir);
  if (!fs.existsSync(file)) {
    process.stderr.write(`run ${run.id} has no events.jsonl\n`);
    return ExitCode.GenericFailure;
  }
  const text = fs.readFileSync(file, "utf8");
  if (options.json) {
    // Byte-for-byte: a trailing newline is added only when missing so a shell
    // prompt never ends up glued to the last event — no line is altered.
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  }
  const events = readEvents(run.dir);
  const seqWidth = Math.max(3, ...events.map((event) => String(event.seq).length));
  const typeWidth = Math.max(4, ...events.map((event) => event.type.length));
  const lines = events.map((event) =>
    `${String(event.seq).padEnd(seqWidth)}  ${event.ts}  ${event.type.padEnd(typeWidth)}  ${eventDetails(event)}`.trimEnd(),
  );
  if (lines.length > 0) {
    process.stdout.write(lines.join("\n") + "\n");
  }
  return 0;
}

/**
 * glm-router runs clean — prunes history (age via `--older-than Nd` or the
 * config default, plus `history.maxRuns`) and reaps orphaned active files.
 * `--dry-run` reports the plan without touching disk (repo convention), and
 * `--orphans` alone narrows the invocation to reaping only.
 */
export function runsCleanCommand(
  options: GlobalOptions & RunsCleanOptions,
  deps: RunsDeps = {},
): number {
  const home = deps.home ?? os.homedir();
  const nowMs = (): number => (deps.now?.() ?? new Date()).getTime();
  const config = loadConfig(home);

  const match = /^(\d+)d$/.exec(options.olderThan ?? "");
  if (options.olderThan !== undefined && match === null) {
    throw Errors.invalidArgs(`--older-than expects "Nd" (e.g. "30d"), got "${options.olderThan}"`);
  }
  const retentionDays = match !== null ? Number(match[1]) : config.history.retentionDays;

  // `runs clean` with no flags is the same opportunistic prune the registry
  // runs at start; `--orphans` alone means "only reap".
  const prune = !(options.orphans === true && options.olderThan === undefined);
  const dryRun = options.dryRun === true;

  let removed: string[] = [];
  if (prune) {
    const limits = { retentionDays, maxRuns: config.history.maxRuns };
    removed = dryRun ? planPrune(home, limits).removed : pruneHistory(home, limits).removed;
  }

  let reaped: string[] = [];
  if (options.orphans === true) {
    const orphans = listActive(home).filter((run) => isOrphaned(run, { now: nowMs, isAlive: deps.isAlive }));
    if (!dryRun) {
      for (const orphan of orphans) {
        reapOrphan(home, orphan);
      }
    }
    reaped = orphans.map((run) => run.id);
  }

  if (options.json) {
    emitJson({ dryRun, retentionDays, maxRuns: config.history.maxRuns, removed, reaped });
    return 0;
  }

  const removeVerb = dryRun ? "would remove" : "removed";
  const reapVerb = dryRun ? "would reap" : "reaped";
  const lines: string[] = [];
  if (removed.length > 0) {
    lines.push(`${removeVerb}:`, ...removed.map((id) => `  ${id}`));
  }
  if (reaped.length > 0) {
    lines.push(`${reapVerb}:`, ...reaped.map((id) => `  ${id}`));
  }
  lines.push(
    `${removeVerb} ${removed.length} ${removed.length === 1 ? "run" : "runs"}, ` +
      `${reapVerb} ${reaped.length} ${reaped.length === 1 ? "orphan" : "orphans"}`,
  );
  if (dryRun) {
    lines.push("(dry run — nothing was changed)");
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

interface ResolvedRun {
  readonly id: string;
  readonly date: string;
  readonly dir: string;
  readonly active: ActiveRun | null;
  readonly ref: RunSummaryRef | null;
}

/**
 * Finds a run by full id or unique suffix — the table shows short ids, so
 * pasting one back must work. An exact match wins before suffixes are
 * considered, so a full id can never be called ambiguous by its own tail.
 */
function resolveRun(home: string, input: string): ResolvedRun {
  const activeRuns = listActive(home);
  const refs = listHistory(home);

  const exactActive = activeRuns.find((run) => run.id === input);
  if (exactActive !== undefined) {
    return {
      id: exactActive.id,
      date: exactActive.date,
      dir: runDir(home, exactActive.date, exactActive.id),
      active: exactActive,
      ref: refs.find((ref) => ref.id === input) ?? null,
    };
  }
  const exactRef = refs.find((ref) => ref.id === input);
  if (exactRef !== undefined) {
    return {
      id: exactRef.id,
      date: exactRef.date,
      dir: runDir(home, exactRef.date, exactRef.id),
      active: null,
      ref: exactRef,
    };
  }

  const suffixActive = activeRuns.filter((run) => run.id.endsWith(input));
  const suffixRefs = refs.filter((ref) => ref.id.endsWith(input));
  // A LIVE run appears in both lists — its history directory exists from the
  // first event, while its active file still exists too — so counting both
  // made `runs show <suffix>` report every running run as ambiguous with
  // itself. Candidates are unique run ids, not list entries.
  const candidateIds = [...new Set([...suffixActive, ...suffixRefs].map((c) => c.id))];
  if (candidateIds.length === 0) {
    throw Errors.invalidArgs(`no run found with id "${input}"`, [`Run "glm-router runs" to list recorded runs.`]);
  }
  if (candidateIds.length > 1) {
    throw Errors.invalidArgs(
      `run id "${input}" is ambiguous — ${candidateIds.length} recorded runs end with it:`,
      candidateIds,
    );
  }
  const id = candidateIds[0];
  // Prefer the active entry: it carries the live state the history ref lacks.
  const run = suffixActive.find((candidate) => candidate.id === id);
  if (run !== undefined) {
    return {
      id: run.id,
      date: run.date,
      dir: runDir(home, run.date, run.id),
      active: run,
      ref: suffixRefs.find((candidate) => candidate.id === id) ?? null,
    };
  }
  const ref = suffixRefs.find((candidate) => candidate.id === id)!;
  return { id: ref.id, date: ref.date, dir: runDir(home, ref.date, ref.id), active: null, ref };
}

/**
 * Dry-run twin of `pruneHistory`: the same two rules (age, then count
 * overflow), computed through `listHistory` so the registry stays the only
 * thing that walks the directories. It can only see real runs — debris
 * directories with no summary and no events are invisible to `listHistory`,
 * which is the honest thing to preview.
 */
function planPrune(home: string, limits: { retentionDays: number; maxRuns: number }): { removed: string[] } {
  const refs = listHistory(home); // newest first
  const expired = refs
    .filter((ref) => Date.now() - Date.parse(`${ref.date}T00:00:00.000Z`) >= limits.retentionDays * DAY_MS)
    .reverse(); // oldest first, the order pruneHistory reports in
  const kept = refs.filter((ref) => !expired.includes(ref)).reverse(); // oldest first
  const overflow = kept.slice(0, Math.max(0, kept.length - limits.maxRuns));
  return { removed: [...expired, ...overflow].map((ref) => ref.id) };
}

/**
 * Moves an orphaned run to history: a FAILED summary rebuilt from the events
 * it managed to write, then the active file goes. With no events there is
 * nothing to summarize — the active file is dropped and the empty directory
 * becomes debris that the next prune collects.
 */
function reapOrphan(home: string, orphan: ActiveRun): void {
  const events = readEvents(runDir(home, orphan.date, orphan.id));
  if (events.length > 0) {
    finishRun(home, orphan.id, { ...summarize(events), id: orphan.id, state: "FAILED" });
    return;
  }
  try {
    fs.rmSync(activeRunFile(home, orphan.id), { force: true });
  } catch (error) {
    // A reap that cannot complete must not fail the whole clean — the next
    // run will reconsider the same orphan.
    logger.debug(`runs clean: reaping ${orphan.id} failed: ${errorMessage(error)}`);
  }
}

interface TurnBlock {
  readonly turn: number;
  readonly entries: readonly string[];
}

/**
 * Rebuilds the per-turn tool tree in the same visual shape the rich progress
 * renderer prints (`◉ Turn n` / `  ├─ Tool  summary`) and stays silent about
 * exactly the events the live renderer is silent about, so replaying history
 * and watching live produce matching views.
 */
function buildTurnTree(events: readonly WorkerEvent[]): TurnBlock[] {
  const blocks = new Map<number, string[]>();
  let currentTurn = 0;
  const block = (turn: number): string[] => {
    let entries = blocks.get(turn);
    if (entries === undefined) {
      entries = [];
      blocks.set(turn, entries);
    }
    return entries;
  };

  for (const event of events) {
    switch (event.type) {
      case "TurnStarted":
        currentTurn = event.turn;
        block(currentTurn);
        break;
      case "ToolStarted":
        // Defensive: a replayed stream without TurnStarted still groups by turn.
        currentTurn = event.turn;
        block(event.turn).push(`${event.tool.padEnd(TOOL_COLUMN_WIDTH)} ${event.summary}`);
        break;
      case "ToolDenied":
        block(event.turn).push(`⚠ denied: ${event.tool} — ${event.reason}`);
        break;
      case "ApiRetry":
        // ApiRetry carries no turn field; it belongs to whatever turn is
        // current, and before the first turn there is nowhere to put it.
        if (currentTurn > 0) {
          block(currentTurn).push(`⚠ retry: ${event.reason}`);
        }
        break;
      case "ValidationCompleted":
        block(event.turn).push(`${event.ok ? "✓" : "✗"} tests ${event.ok ? "passed" : "failed"}`);
        break;
      default:
        break;
    }
  }
  return [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turn, entries]) => ({ turn, entries }));
}

/** The closing line of `runs show`, mirroring the progress renderer's footer. */
function terminalLine(events: readonly WorkerEvent[]): string {
  for (const event of events) {
    if (event.type === "RunCompleted") {
      return "✓ Completed";
    }
    if (event.type === "RunFailed") {
      return `✗ Failed — ${event.reason}`;
    }
    if (event.type === "RunCancelled") {
      return "✗ Cancelled";
    }
  }
  return "✗ Crashed — no terminal event was recorded";
}

/**
 * Per-row metadata from the first line of `events.jsonl` — kind, model and cwd
 * live only there, and reading whole streams would make listing O(history).
 */
function readRunStartInfo(
  dir: string,
): { readonly kind: string | null; readonly model: string | null; readonly cwd: string | null } {
  try {
    const firstLine = fs.readFileSync(eventsFilePath(dir), "utf8").split(/\r?\n/, 1)[0] ?? "";
    if (firstLine.trim() === "") {
      return { kind: null, model: null, cwd: null };
    }
    const parsed: unknown = JSON.parse(firstLine);
    if (typeof parsed !== "object" || parsed === null) {
      return { kind: null, model: null, cwd: null };
    }
    const record = parsed as Record<string, unknown>;
    const text = (key: string): string | null => (typeof record[key] === "string" ? record[key] : null);
    return { kind: text("kind"), model: text("model"), cwd: text("cwd") };
  } catch {
    return { kind: null, model: null, cwd: null };
  }
}

/**
 * Column widths are computed from the data, never hardcoded: status.ts's fixed
 * padding was a reported defect, and a cwd or model name of any length must
 * not break the table.
 */
function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map(
    (header, column) => Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

/** Local time, built from the date's own components so no locale can change it. */
function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  const p2 = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())} ` +
    `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`
  );
}

/** "5.4s", "2m 13s", "1h 04m" — one decimal below a minute, where it is honest. */
function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "—";
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Milliseconds since an ISO timestamp, clamped at 0; null when unparseable. */
function elapsedSince(iso: string, now: () => Date): number | null {
  const startedMs = Date.parse(iso);
  return Number.isFinite(startedMs) ? Math.max(0, now().getTime() - startedMs) : null;
}

/** JSON.stringify quotes and escapes values with spaces, exactly what logs need. */
function quote(value: string): string {
  return JSON.stringify(value);
}

/** Compact `key=value` details for one event — the human half of `runs logs`. */
function eventDetails(event: WorkerEvent): string {
  switch (event.type) {
    case "RunStarted":
      return `kind=${event.kind} model=${event.model} cwd=${quote(event.cwd)} task=${quote(event.taskTitle)}`;
    case "AgentInitialized":
      return `session=${event.sessionId} model=${event.model} tools=${event.tools.length}`;
    case "TurnStarted":
      return `turn=${event.turn}`;
    case "ToolStarted":
      return `turn=${event.turn} tool=${event.tool} summary=${quote(event.summary)}`;
    case "ToolCompleted":
      return `turn=${event.turn} tool=${event.tool} ok=${String(event.ok)} ${String(event.durationMs)}ms`;
    case "FileChanged":
      return `turn=${event.turn} op=${event.op} path=${event.path}`;
    case "ValidationStarted":
      return `turn=${event.turn} command=${quote(event.command)}`;
    case "ValidationCompleted":
      return `turn=${event.turn} command=${quote(event.command)} ok=${String(event.ok)} ${String(event.durationMs)}ms`;
    case "ToolDenied":
      return `turn=${event.turn} tool=${event.tool} reason=${quote(event.reason)}`;
    case "ApiRetry":
      return event.attempt === undefined
        ? `reason=${quote(event.reason)}`
        : `attempt=${event.attempt} reason=${quote(event.reason)}`;
    case "BudgetWarning":
      return (
        `zone=${event.zone} remainingRatio=${String(event.remainingRatio)} ` +
        `usableBudget=${String(event.usableBudget)} estimatedRemaining=${String(event.estimatedRemaining)}`
      );
    case "CheckpointCreated":
      return `phase=${event.phase} path=${event.path}`;
    case "HandoffStarted":
      return `reason=${quote(event.reason)}`;
    case "HandoffCompleted":
      return `reason=${quote(event.reason)} bundle=${event.bundlePath}`;
    case "RunCompleted":
      return (
        `turns=${event.turns} duration=${String(event.durationMs)}ms files=${String(event.filesChanged)} ` +
        `tokensIn=${String(event.tokensIn)} tokensOut=${String(event.tokensOut)}`
      );
    case "RunFailed":
      return `reason=${quote(event.reason)} exit=${String(event.exitCode)}`;
    case "RunCancelled":
      return `signal=${event.signal}`;
    case "Heartbeat":
      return `state=${event.state} turn=${String(event.turn)}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}




