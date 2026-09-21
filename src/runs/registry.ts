import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { logger, redact } from "../core/logging.js";
import { activeRunFile, activeRunsDir, runDir, runsDir } from "../core/paths.js";
import { atomicWriteFile } from "../project/atomic-write.js";
import { ZAI_API_KEY_ENV } from "../core/zai-key.js";
import type { AgentRole, ProviderId } from "../events/types.js";
import { eventsFilePath } from "./store.js";
import type { RunOutcome, RunSummary } from "./store.js";

/** C3: 120 chars is the widest a task title may ever be on disk or in a line. */
export const TASK_TITLE_MAX_CHARS = 120;

/**
 * A heartbeat older than this (30 s = six missed 5 s ticks) plus a dead pid
 * is what makes a run orphaned. The threshold is a property of the liveness
 * protocol, not a user knob — tuning it without the heartbeat interval would
 * silently break orphan detection.
 */
export const ORPHAN_HEARTBEAT_MS = 30_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Run metadata persisted to disk (doc §5). `provider` is the canonical id
 * `zai.zcode` (H2/D5) — the roadmap doc's `"glm"` predates that decision, and
 * persisted history must carry the id v3/v4 will route on. `taskTitle` and
 * `taskHash` identify the task without ever persisting the prompt body (C3).
 */
export interface RunMeta {
  readonly id: string;
  readonly kind: "worker" | "review" | "delegate";
  readonly provider: ProviderId;
  readonly role: AgentRole;
  readonly model: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly parent: { readonly type: "claude" | "codex" | "shell" };
  readonly taskTitle: string;
  readonly taskHash: string;
  readonly pid: number;
  readonly date: string;
}

/** Which CLI surface started the run. */
export type RunKind = RunMeta["kind"];

/**
 * v4 §21's state names (H6). No PREFLIGHT, no CHECKPOINT — a translation
 * table later would cost more than using the future names now.
 */
export type RunState =
  | "QUEUED"
  | "ROUTING"
  | "RUNNING"
  | "DRAINING"
  | "CHECKPOINTING"
  | "HANDOFF"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** The registry entry for a run that has not finished yet. */
export interface ActiveRun extends RunMeta {
  readonly state: RunState;
  readonly heartbeatAt: string;
}

/** The only fields of an active run that change after creation. */
export type RunPatch = Partial<Pick<ActiveRun, "state" | "heartbeatAt">>;

export interface CreateRunDeps {
  readonly home: string;
  readonly now?: () => Date;
}

export interface OrphanCheckDeps {
  readonly now?: () => number;
  /** Defaults to the `process.kill(pid, 0)` probe; injectable so tests never touch a real process. */
  readonly isAlive?: (pid: number) => boolean;
}

export interface RunHistoryFilter {
  readonly kind?: RunKind;
  readonly state?: RunOutcome;
}

/** One history entry as `runs` lists it: where the run lives, how it ended. */
export interface RunSummaryRef {
  readonly id: string;
  readonly date: string;
  readonly kind: RunKind | null;
  readonly state: RunOutcome;
  readonly startedAt: string | null;
  /** Null when the run crashed before writing one — the events file is all it left. */
  readonly summary: RunSummary | null;
}

export interface PruneLimits {
  readonly retentionDays: number;
  readonly maxRuns: number;
}

/**
 * C3: the first line of the prompt, redacted, cut to 120 chars — the only
 * prompt-derived text ever persisted.
 *
 * `secrets` exists because the process environment is NOT where the key
 * lives on the platform this ships to: `resolveZaiApiKey` reads it from the
 * Windows User Environment (or a keychain) precisely so it stays out of
 * `process.env`. A caller that already resolved the key passes it here; the
 * env var is only a fallback for when it happens to be exported.
 */
export function taskTitleOf(prompt: string, secrets: readonly (string | undefined)[] = []): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? "";
  return redact(firstLine, [...secrets, process.env[ZAI_API_KEY_ENV]]).slice(
    0,
    TASK_TITLE_MAX_CHARS,
  );
}

/**
 * C3: sha256 of the FULL prompt. The hash lets the estimator recognize the
 * same task again while the body itself never touches disk.
 */
export function taskHashOf(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/**
 * Registers a run and creates its history directory immediately — not at the
 * end — so `watch` can attach to a run that is still going. Only this
 * function propagates filesystem errors: a run whose registry entry cannot be
 * written exists nowhere, and the caller must decide what to do about that.
 */
export function createRun(meta: RunMeta, deps: CreateRunDeps): ActiveRun {
  fs.mkdirSync(runDir(deps.home, meta.date, meta.id), { recursive: true });
  fs.mkdirSync(activeRunsDir(deps.home), { recursive: true });
  const active: ActiveRun = {
    ...meta,
    state: "RUNNING",
    heartbeatAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  atomicWriteFile(activeRunFile(deps.home, meta.id), serialize(active));
  return active;
}

/**
 * Atomically patches the active file. Returns null — never throws — when the
 * entry is missing or corrupt: a stale registry file must not take the run
 * down with it, and callers (the heartbeat) treat null as "skip quietly".
 */
export function updateRun(home: string, id: string, patch: RunPatch): ActiveRun | null {
  const file = activeRunFile(home, id);
  try {
    const current = readJsonFile(file);
    if (!isStoredRun(current)) {
      logger.debug(`updateRun: ${file} is missing or not a run entry`);
      return null;
    }
    const next: ActiveRun = { ...current, ...patch };
    atomicWriteFile(file, serialize(next));
    return next;
  } catch (error) {
    logger.debug(`updateRun: patching ${id} failed: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Writes `summary.json` into the run's history directory, then deletes the
 * active file — that order is what makes "active file gone but no summary" a
 * crash signature rather than a possible intermediate state of a clean run.
 * Never throws: a run that already finished is not worth failing `finishRun`
 * over, so every failure is logged at debug and skipped.
 */
export function finishRun(home: string, id: string, summary: RunSummary): void {
  const dir = locateRunDir(home, id);
  if (dir === null) {
    logger.debug(`finishRun: no history directory found for ${id}`);
    return;
  }
  try {
    atomicWriteFile(path.join(dir, "summary.json"), serialize(summary));
  } catch (error) {
    logger.debug(`finishRun: writing summary for ${id} failed: ${errorMessage(error)}`);
    return;
  }
  try {
    fs.rmSync(activeRunFile(home, id), { force: true });
  } catch (error) {
    logger.debug(`finishRun: removing active file for ${id} failed: ${errorMessage(error)}`);
  }
}

/** Every registered run that claims to be alive, newest first. Corrupt files are skipped, never fatal. */
export function listActive(home: string): ActiveRun[] {
  const dir = activeRunsDir(home);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const runs: ActiveRun[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const entry = readJsonFile(path.join(dir, name));
    if (isStoredRun(entry)) {
      runs.push(entry);
    } else {
      logger.debug(`listActive: skipping unreadable entry ${name}`);
    }
  }
  // ULIDs sort chronologically, so id order is start order with no parsing.
  return runs.sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** History entries, newest first, optionally filtered by kind and/or terminal state. */
export function listHistory(home: string, filter: RunHistoryFilter = {}): RunSummaryRef[] {
  const refs: RunSummaryRef[] = [];
  for (const date of historyDates(home)) {
    for (const id of runIdsIn(path.join(historyRoot(home), date))) {
      const ref = readSummaryRef(home, date, id);
      if (
        ref !== null &&
        (filter.kind === undefined || ref.kind === filter.kind) &&
        (filter.state === undefined || ref.state === filter.state)
      ) {
        refs.push(ref);
      }
    }
  }
  // Dates and ids were read sorted ascending; reverse for newest-first.
  return refs.reverse();
}

/**
 * Enforces `retentionDays` then `maxRuns` (oldest first), called
 * opportunistically — a pruning failure must never block the work around it.
 * Returns the removed run ids so `runs clean` can say what it did.
 */
export function pruneHistory(home: string, limits: PruneLimits): { removed: string[] } {
  const now = Date.now();
  const entries: { date: string; id: string; dateMs: number }[] = [];

  for (const date of historyDates(home)) {
    const dateMs = Date.parse(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(dateMs)) {
      logger.debug(`pruneHistory: skipping non-date directory ${date}`);
      continue;
    }
    for (const id of runIdsIn(path.join(historyRoot(home), date))) {
      entries.push({ date, id, dateMs });
    }
  }

  const expired = entries.filter((entry) => now - entry.dateMs >= limits.retentionDays * DAY_MS);
  const kept = entries
    .filter((entry) => !expired.includes(entry))
    .sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
  // Oldest first, only as many as exceed the cap.
  const overflow = kept.slice(0, Math.max(0, kept.length - limits.maxRuns));

  const removed: string[] = [];
  const touchedDates = new Set<string>();
  for (const entry of [...expired, ...overflow]) {
    try {
      fs.rmSync(runDir(home, entry.date, entry.id), { recursive: true, force: true });
      removed.push(entry.id);
      touchedDates.add(entry.date);
    } catch (error) {
      logger.debug(`pruneHistory: removing ${entry.id} failed: ${errorMessage(error)}`);
    }
  }
  for (const date of touchedDates) {
    try {
      fs.rmdirSync(path.join(historyRoot(home), date));
    } catch {
      // Directory not empty (a kept/failed removal lives there) — nothing to do.
    }
  }
  return { removed };
}

/**
 * True when the heartbeat is stale AND the process is gone. Both conditions:
 * a fresh heartbeat with a dead pid is a run that just hasn't ticked again,
 * and a stale heartbeat with a live pid is a busy worker, not an orphan.
 */
export function isOrphaned(run: ActiveRun, deps: OrphanCheckDeps = {}): boolean {
  const now = deps.now?.() ?? Date.now();
  const heartbeatAge = now - Date.parse(run.heartbeatAt);
  // A NaN age (unparseable heartbeatAt) fails the comparison, so a corrupt
  // entry is treated as fresh rather than reaped on a technicality.
  if (!(heartbeatAge > ORPHAN_HEARTBEAT_MS)) {
    return false;
  }
  const isAlive = deps.isAlive ?? defaultIsAlive;
  return !isAlive(run.pid);
}

/**
 * The liveness probe: `process.kill(pid, 0)` sends no signal, it only asks
 * the OS whether the process exists. EPERM means it exists but belongs to
 * someone else — that is a live pid, not a dead one.
 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function historyRoot(home: string): string {
  return path.join(runsDir(home), "history");
}

/** Date directories, sorted oldest first so consumers can rely on iteration order. */
function historyDates(home: string): string[] {
  try {
    return fs
      .readdirSync(historyRoot(home), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function runIdsIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Builds one history entry. `summary.json` answers "how did it end"; when it
 * is missing the run crashed, and kind/startedAt come from the first line of
 * `events.jsonl` (a `RunStarted`, written before anything could crash).
 */
function readSummaryRef(home: string, date: string, id: string): RunSummaryRef | null {
  const dir = runDir(home, date, id);
  const summary = readJsonFile(path.join(dir, "summary.json"));
  const firstEvent = readFirstEvent(dir);

  if (!isSummary(summary) && firstEvent === null) {
    // Neither artifact is readable — debris, not a run worth listing.
    logger.debug(`listHistory: skipping ${dir} (no readable summary or events)`);
    return null;
  }

  const state: RunOutcome = isSummary(summary) ? summary.state : "CRASHED";
  return {
    id,
    date,
    kind: firstEvent?.kind ?? null,
    state,
    startedAt: firstEvent?.startedAt ?? null,
    summary: isSummary(summary) ? summary : null,
  };
}

/** The first line of `events.jsonl`, or null — reading more would make a listing O(stream). */
function readFirstEvent(dir: string): { kind: RunKind | null; startedAt: string } | null {
  try {
    const firstLine = fs.readFileSync(eventsFilePath(dir), "utf8").split(/\r?\n/, 1)[0] ?? "";
    if (firstLine.trim() === "") {
      return null;
    }
    const parsed: unknown = JSON.parse(firstLine);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.ts !== "string") {
      return null;
    }
    return {
      kind: typeof record.kind === "string" ? (record.kind as RunKind) : null,
      startedAt: record.ts,
    };
  } catch {
    return null;
  }
}

/**
 * Where a run's history directory is. The active file is the fast path; the
 * scan exists so `finishRun` still works when the active file was already
 * reaped (crashed process, later cleanup).
 */
function locateRunDir(home: string, id: string): string | null {
  const entry = readJsonFile(activeRunFile(home, id));
  if (isStoredRun(entry)) {
    const dir = runDir(home, entry.date, id);
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  for (const date of historyDates(home)) {
    const dir = runDir(home, date, id);
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Deliberately shallow: enough to know the file is a run entry, not a full
 * schema check — a future field must not make every old entry unreadable.
 */
function isStoredRun(value: unknown): value is ActiveRun {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.state === "string" &&
    typeof record.heartbeatAt === "string"
  );
}

function isSummary(value: unknown): value is RunSummary {
  return typeof value === "object" && value !== null && typeof (value as { state?: unknown }).state === "string";
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
