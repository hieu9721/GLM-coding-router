import os from "node:os";
import path from "node:path";
import { loadConfig } from "../core/config.js";
import { Errors } from "../core/errors.js";
import { logger } from "../core/logging.js";
import { runDir } from "../core/paths.js";
import { resolveZaiApiKey } from "../core/zai-key.js";
import type { ResolvedZaiKey } from "../core/zai-key.js";
import { isOrphaned, listActive, listHistory, type RunSummaryRef } from "../runs/registry.js";
import { readEvents } from "../runs/store.js";
import { ansi, createWriter, paint, type Style, type Writer } from "../tui/render.js";
import { describeWindow, fetchZaiQuota } from "./usage.js";
import type { ZaiLimit } from "./usage.js";
import { emitJson, type GlobalOptions } from "./context.js";

// Display-only zone thresholds for the dashboard's one-word verdict. Phase E
// owns the real routing thresholds (routing.preferFlashBelow etc.); these must
// stay independent so restyling the dashboard can never change a routing
// decision, and vice versa.
const ZONE_OK_ABOVE_RATIO = 0.3;
const ZONE_LOW_ABOVE_RATIO = 0.15;

/** Doc §8: recent runs are the last few, not the whole history. */
const RECENT_LIMIT = 5;

const DEFAULT_INTERVAL_SEC = 2;

type ZoneWord = "ok" | "low" | "critical" | "unknown";

export interface DashboardOptions {
  /** Repaint interval in seconds (TTY only). */
  readonly interval?: number;
}

export interface DashboardDeps {
  readonly home?: string;
  readonly now?: () => Date;
  /** Orphan detection probe; injectable so tests never signal a real pid. */
  readonly isAlive?: (pid: number) => boolean;
  /** Quota fetch; injectable so tests never touch the network. */
  readonly fetchImpl?: typeof fetch;
  /** Key resolution; injectable so tests never read the real store. */
  readonly resolveKey?: () => ResolvedZaiKey | undefined;
  readonly stdout?: NodeJS.WriteStream | NodeJS.WritableStream;
  readonly isTTY?: boolean;
}

interface QuotaWindowView {
  /** describeWindow()'s label — the enum mapping lives there, once. */
  readonly window: string;
  readonly used: number | null;
  readonly limit: number | null;
  readonly percent: number | null;
  readonly remainingRatio: number | null;
  readonly resetsAt: string | null;
}

interface QuotaView {
  readonly ok: boolean;
  readonly level: string | null;
  readonly zone: ZoneWord;
  readonly windows: readonly QuotaWindowView[];
  readonly error: string | null;
}

interface ActiveRowView {
  readonly id: string;
  readonly state: string;
  readonly kind: string;
  readonly model: string;
  readonly elapsedMs: number | null;
  readonly cwd: string;
  readonly orphaned: boolean;
}

interface RecentRowView {
  readonly id: string;
  readonly state: string;
  readonly durationMs: number | null;
  readonly turns: number | null;
  readonly files: number | null;
  readonly reason: string | null;
}

interface Snapshot {
  readonly generatedAt: string;
  readonly quota: QuotaView;
  readonly active: readonly ActiveRowView[];
  readonly recent: readonly RecentRowView[];
  readonly model: string;
}

/**
 * glm-router dashboard — quota + active runs + recent runs + errors in one
 * frame (doc §8). Non-TTY (or --json) prints exactly ONE snapshot and exits 0,
 * so the command is pipeable and a monitoring outage never looks like a broken
 * tool; TTY repaints the whole frame every --interval seconds until Ctrl+C.
 */
export async function dashboardCommand(
  options: GlobalOptions & DashboardOptions,
  deps: DashboardDeps = {},
): Promise<number> {
  const intervalSec = options.interval ?? DEFAULT_INTERVAL_SEC;
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    throw Errors.invalidArgs(`--interval expects a positive number of seconds, got "${String(options.interval)}"`);
  }
  const stream = deps.stdout ?? process.stdout;
  const isTTY = deps.isTTY ?? (stream as { isTTY?: boolean }).isTTY === true;

  if (options.json || !isTTY) {
    const snapshot = await buildSnapshot(deps);
    if (options.json) {
      emitJson(snapshotJson(snapshot));
    } else {
      const writer = createWriter(stream); // non-TTY: color off, no ANSI
      writer.line(renderSnapshot(snapshot, writer));
    }
    return 0;
  }

  // TTY: repaint by clearing and rewriting — never scroll. All cursor control
  // goes through render.ts's ansi helpers (D1: no escape codes here).
  const writer = createWriter(stream);
  writer.write(ansi.hideCursor);
  return new Promise<number>((resolve) => {
    let paintedLines = 0;
    let painting = false;
    let stopped = false;
    const stop = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      process.removeListener("SIGINT", onSigint);
      writer.write(ansi.showCursor);
      resolve(0);
    };
    const onSigint = (): void => stop();
    const repaint = async (): Promise<void> => {
      if (stopped || painting) {
        return;
      }
      painting = true;
      try {
        const frame = renderSnapshot(await buildSnapshot(deps), writer);
        if (stopped) {
          return;
        }
        if (paintedLines > 0) {
          const clear = ansi.cursorUp(1) + ansi.clearLine;
          writer.write(clear.repeat(paintedLines));
        }
        writer.write(`${frame}\n`);
        paintedLines = frame.split("\n").length;
      } catch (error) {
        // One failed repaint (e.g. a transient quota timeout) must not kill
        // the loop; the next tick replaces the frame.
        logger.debug(`dashboard: repaint failed: ${errorMessage(error)}`);
      } finally {
        painting = false;
      }
    };
    const timer = setInterval(() => {
      void repaint();
    }, intervalSec * 1000);
    process.on("SIGINT", onSigint);
    void repaint();
  });
}

/** Gathers one frame from the quota endpoint and the run registry. */
async function buildSnapshot(deps: DashboardDeps): Promise<Snapshot> {
  const home = deps.home ?? os.homedir();
  const now = deps.now ?? (() => new Date());
  const nowMs = now().getTime();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveKey = deps.resolveKey ?? ((): ResolvedZaiKey | undefined => resolveZaiApiKey());

  // Fail-open by contract: a monitoring outage must never fail the dashboard
  // (or block work) — it renders as one unavailable line, exit stays 0.
  let quota: QuotaView;
  const resolved = resolveKey();
  if (resolved === undefined) {
    quota = { ok: false, level: null, zone: "unknown", windows: [], error: "no Z.ai API key configured" };
  } else {
    try {
      const data = await fetchZaiQuota(resolved.key, fetchImpl);
      const windows = (data.limits ?? []).map(windowView);
      quota = {
        ok: true,
        level: data.level ?? null,
        zone: zoneFor(windows.map((window) => window.remainingRatio)),
        windows,
        error: null,
      };
    } catch (error) {
      quota = {
        ok: false,
        level: null,
        zone: "unknown",
        windows: [],
        error: errorMessage(error),
      };
    }
  }

  const active: ActiveRowView[] = listActive(home).map((run) => ({
    id: run.id,
    state: run.state,
    kind: run.kind,
    model: run.model,
    elapsedMs: elapsedSince(run.startedAt, nowMs),
    cwd: run.cwd,
    orphaned: isOrphaned(run, { now: () => nowMs, isAlive: deps.isAlive }),
  }));

  // `listHistory` also returns active runs (their directory exists from the
  // first event, with no summary yet — which reads as CRASHED). Recent Runs is
  // "how runs ended": the live ones are the section above, and showing them
  // here as crashed would be actively misleading.
  const activeIds = new Set(active.map((row) => row.id));
  const recent: RecentRowView[] = listHistory(home)
    .filter((ref) => !activeIds.has(ref.id))
    .slice(0, RECENT_LIMIT)
    .map((ref) => ({
      id: ref.id,
      state: ref.state,
      durationMs: ref.summary?.durationMs ?? null,
      turns: ref.summary?.turns ?? null,
      files: ref.summary?.filesChanged.length ?? null,
      reason: failedReason(home, ref),
    }));

  return { generatedAt: new Date(nowMs).toISOString(), quota, active, recent, model: loadConfig(home).models.main };
}

/** The machine shape — mirrors the text frame key for key. */
function snapshotJson(snapshot: Snapshot): unknown {
  return {
    generatedAt: snapshot.generatedAt,
    model: snapshot.model,
    quota: snapshot.quota,
    active: snapshot.active,
    recent: snapshot.recent,
    errors: snapshot.recent
      .filter((row) => row.state === "FAILED" || row.state === "CRASHED")
      .map((row) => ({ id: row.id, state: row.state, reason: row.reason })),
  };
}

function renderSnapshot(snapshot: Snapshot, writer: Writer): string {
  const lines: string[] = [`GLM Coding Router — dashboard ${formatLocalTime(snapshot.generatedAt)}`, ""];

  if (snapshot.quota.ok) {
    const level = snapshot.quota.level !== null ? ` (level: ${snapshot.quota.level})` : "";
    lines.push(`Quota${level} — ${paintZone(writer, snapshot.quota.zone)}`);
    if (snapshot.quota.windows.length === 0) {
      lines.push("  (no quota windows reported)");
    }
    for (const window of snapshot.quota.windows) {
      const used = window.used !== null ? String(window.used) : "?";
      const total = window.limit !== null ? String(window.limit) : "?";
      const percent = window.percent !== null ? ` (${String(window.percent)}%)` : "";
      const resets = window.resetsAt !== null ? ` · resets ${window.resetsAt}` : "";
      lines.push(
        `  ${window.window.padEnd(15)} ${used} / ${total} credits${percent} · ` +
          `${paintZone(writer, zoneFor([window.remainingRatio]))}${resets}`,
      );
    }
  } else {
    lines.push("Quota", `  quota unavailable — ${snapshot.quota.error ?? "unknown error"}`);
  }

  lines.push("", "Active Runs");
  if (snapshot.active.length === 0) {
    lines.push("  (none)");
  } else {
    const rows = snapshot.active.map((row) => [
      row.id.slice(-6),
      row.state,
      row.kind,
      row.model,
      row.elapsedMs !== null ? formatDuration(row.elapsedMs) : "—",
      (path.basename(row.cwd) || row.cwd) + (row.orphaned ? paint(writer, "yellow", " (orphaned)") : ""),
    ]);
    for (const line of renderRows(rows)) {
      lines.push(`  ${line}`);
    }
  }

  lines.push("", "Recent Runs");
  if (snapshot.recent.length === 0) {
    lines.push("  (none)");
  } else {
    for (const row of snapshot.recent) {
      const numbers =
        row.durationMs === null && row.turns === null && row.files === null
          ? "—"
          : [
              row.durationMs !== null ? formatDuration(row.durationMs) : null,
              row.turns !== null ? `${String(row.turns)} ${row.turns === 1 ? "turn" : "turns"}` : null,
              row.files !== null ? `${String(row.files)} ${row.files === 1 ? "file" : "files"}` : null,
            ]
              .filter((part) => part !== null)
              .join(" · ");
      lines.push(`  ${row.id.slice(-6)}  ${row.state.padEnd(10)} ${numbers}`);
    }
  }

  const failed = snapshot.recent.filter((row) => row.state === "FAILED" || row.state === "CRASHED");
  lines.push("", "Errors");
  if (failed.length === 0) {
    lines.push("  (none)");
  } else {
    for (const row of failed) {
      const reason = row.reason !== null ? ` — ${row.reason}` : "";
      lines.push(`  ${paint(writer, "red", `✗ ${row.id.slice(-6)} ${row.state}${reason}`)}`);
    }
  }

  lines.push("", `Model  ${snapshot.model}`);
  return lines.join("\n");
}

function paintZone(writer: Writer, zone: ZoneWord): string {
  const style: Style | null =
    zone === "ok" ? "green" : zone === "low" ? "yellow" : zone === "critical" ? "red" : null;
  return style !== null ? paint(writer, style, zone) : zone;
}

/**
 * Worst window wins, matching how the router will judge the budget: a healthy
 * 5-hour window cannot paper over an exhausted weekly one.
 */
function zoneFor(ratios: readonly (number | null)[]): ZoneWord {
  const known = ratios.filter((ratio): ratio is number => typeof ratio === "number" && Number.isFinite(ratio));
  if (known.length === 0) {
    return "unknown";
  }
  const worst = Math.min(...known);
  if (worst > ZONE_OK_ABOVE_RATIO) {
    return "ok";
  }
  if (worst > ZONE_LOW_ABOVE_RATIO) {
    return "low";
  }
  return "critical";
}

function windowView(limit: ZaiLimit): QuotaWindowView {
  const used = typeof limit.currentValue === "number" ? limit.currentValue : null;
  const total = typeof limit.usage === "number" ? limit.usage : null;
  const percent =
    typeof limit.percentage === "number"
      ? limit.percentage
      : used !== null && total !== null && total > 0
        ? Math.round((used / total) * 100)
        : null;
  const remainingRatio =
    typeof limit.remaining === "number" && total !== null && total > 0
      ? limit.remaining / total
      : percent !== null
        ? (100 - percent) / 100
        : null;
  const resetsAt =
    typeof limit.nextResetTime === "number" && Number.isFinite(limit.nextResetTime)
      ? new Date(limit.nextResetTime).toISOString()
      : null;
  return { window: describeWindow(limit), used, limit: total, percent, remainingRatio, resetsAt };
}

/**
 * Why a run failed. `RunSummary` carries no reason field today (Phase B's
 * choice), so the line falls back to the run's own `RunFailed` event — read
 * only for FAILED/CRASHED entries, at most RECENT_LIMIT of them.
 */
function failedReason(home: string, ref: RunSummaryRef): string | null {
  if (ref.state !== "FAILED" && ref.state !== "CRASHED") {
    return null;
  }
  const fromSummary = ref.summary !== null ? (ref.summary as { reason?: unknown }).reason : undefined;
  if (typeof fromSummary === "string" && fromSummary.length > 0) {
    return fromSummary;
  }
  const events = readEvents(runDir(home, ref.date, ref.id));
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === "RunFailed") {
      return event.reason;
    }
  }
  return null;
}

/** Pads each column to the widest cell — a model or cwd of any length must not break the frame. */
function renderRows(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd());
}

/** Milliseconds since an ISO timestamp; null when unparseable. */
function elapsedSince(iso: string, nowMs: number): number | null {
  const startedMs = Date.parse(iso);
  return Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null;
}

/** Local time built from the date's own components so no locale can change it. */
function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
