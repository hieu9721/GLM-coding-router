import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchZaiQuota } from "../core/zai-quota.js";
import type { ZaiLimit, ZaiQuotaData } from "../core/zai-quota.js";
import { logger } from "../core/logging.js";
import { quotaCachePath } from "../core/paths.js";

export interface BudgetWindow {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly remainingRatio: number;
  readonly resetAt: string | null;
}

export interface BudgetSnapshot {
  /** Canonical provider id (H2/D5) — "GLM" is display text, never persisted. */
  readonly provider: "zai.zcode";
  /** What the numbers count (H7): plan credits, never currency. */
  readonly unit: "credit";
  /** How the credits are paid for (H7): subscription, not pay-as-you-go. */
  readonly costClass: "subscription";
  readonly fiveHour: BudgetWindow;
  readonly weekly: BudgetWindow;
  readonly confidence: "exact" | "cached" | "unknown";
  /** ISO. On a cached snapshot this is when the *fetch* happened, not the read. */
  readonly fetchedAt: string;
}

export type BudgetZone = "HEALTHY" | "CONSERVE" | "HANDOFF_READY" | "CRITICAL";

/** Same TTL as the shipped config default; callers pass routing.quotaCacheTtlSec. */
const DEFAULT_TTL_SEC = 60;

const ZERO_WINDOW: BudgetWindow = {
  used: 0,
  limit: 0,
  remaining: 0,
  remainingRatio: 0,
  resetAt: null,
};

/**
 * Maps one CREDIT_LIMIT entry onto a BudgetWindow. The server's `remaining`
 * is authoritative even though the real payload does not add up
 * (912 + 1087 = 1999 of 2000) — recomputing it would silently change the
 * number routing decides on. `limit - used` is only a fallback for when the
 * server omits `remaining` entirely.
 */
function windowFrom(limit: ZaiLimit | undefined): BudgetWindow {
  if (limit === undefined) {
    return ZERO_WINDOW;
  }
  const limitValue = finiteNumber(limit.usage) ?? 0;
  const used = finiteNumber(limit.currentValue) ?? 0;
  const remaining = finiteNumber(limit.remaining) ?? limitValue - used;
  return {
    used,
    limit: limitValue,
    remaining,
    // 0 — never NaN, never Infinity — when the limit is 0 or missing, so the
    // ratio math downstream (zoneFor, the Phase E router) stays finite no
    // matter what the endpoint reports.
    remainingRatio: limitValue > 0 ? remaining / limitValue : 0,
    resetAt:
      typeof limit.nextResetTime === "number" && Number.isFinite(limit.nextResetTime)
        ? new Date(limit.nextResetTime).toISOString()
        : null,
  };
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Window mapping verified live (specs/usage.md): `unit 3` is the 5-hour
 * window, `unit 6 & number 1` the weekly one. Other entries are windows this
 * build does not route on and are ignored.
 */
function snapshotFrom(data: ZaiQuotaData, fetchedAt: string): BudgetSnapshot {
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const fiveHour = limits.find((limit) => limit.unit === 3);
  const weekly = limits.find((limit) => limit.unit === 6 && limit.number === 1);
  // Fail-open has a side door, and this closes it. A 200 response that carries
  // neither window is a real state of this endpoint, not a hypothetical —
  // `usage.ts` already renders "(no quota windows reported)" for it. Mapped
  // naively it becomes an "exact" all-zero snapshot, which zoneFor reads as
  // CRITICAL: every run downgraded and warned today, every run refused once
  // refuseOnCritical flips in 2.1 — on a payload that told us nothing at all.
  // A window we cannot see is unknown, never empty. Both are required because
  // the router reasons about GLM's 5-hour/weekly PAIR; with one of them
  // missing the min() that picks the binding window is meaningless.
  if (fiveHour === undefined || weekly === undefined) {
    logger.debug("budget: quota payload carried no recognizable 5-hour/weekly pair, treating as unknown");
    return unknownSnapshot(fetchedAt);
  }
  return {
    provider: "zai.zcode",
    unit: "credit",
    costClass: "subscription",
    fiveHour: windowFrom(fiveHour),
    weekly: windowFrom(weekly),
    confidence: "exact",
    fetchedAt,
  };
}

function unknownSnapshot(fetchedAt: string): BudgetSnapshot {
  return {
    provider: "zai.zcode",
    unit: "credit",
    costClass: "subscription",
    fiveHour: ZERO_WINDOW,
    weekly: ZERO_WINDOW,
    confidence: "unknown",
    fetchedAt,
  };
}

/**
 * The Z.ai quota as a BudgetSnapshot, read through a short-lived file cache
 * so a burst of runs makes ONE request.
 *
 * FAIL-OPEN is the contract of this function: no key, endpoint down, HTTP
 * error, malformed body, unparseable cache — every one of those returns an
 * all-zero snapshot with confidence "unknown". This function never throws
 * and never rejects; a monitoring outage must not block work, it degrades
 * routing to "run normally".
 */
export async function fetchBudget(deps: {
  home?: string;
  key?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  refresh?: boolean;
  ttlSec?: number;
}): Promise<BudgetSnapshot> {
  const home = deps.home ?? os.homedir();
  const now = deps.now ?? ((): Date => new Date());
  const ttlSec = deps.ttlSec ?? DEFAULT_TTL_SEC;

  try {
    // `refresh` (what --refresh-quota will drive) bypasses the cache without
    // deleting it — the next normal read may still use the fresh entry this
    // fetch writes.
    if (!deps.refresh) {
      const cached = readCachedSnapshot(home);
      // NaN from an unparseable fetchedAt compares false, i.e. stale: a cache
      // entry with no valid timestamp must never suppress a live fetch.
      if (cached !== null && now().getTime() - Date.parse(cached.fetchedAt) < ttlSec * 1000) {
        return { ...cached, confidence: "cached" };
      }
    }

    if (deps.key === undefined || deps.key.length === 0) {
      return unknownSnapshot(now().toISOString());
    }

    const data = await fetchZaiQuota(deps.key, deps.fetchImpl ?? fetch);
    const snapshot = snapshotFrom(data, now().toISOString());
    writeCachedSnapshot(home, snapshot);
    return snapshot;
  } catch (error) {
    logger.debug(`budget: quota unavailable, failing open (${errorMessage(error)})`);
    return unknownSnapshot(now().toISOString());
  }
}

/**
 * Zone classification for routing and warnings (doc §11). The worst window
 * wins — a healthy 5-hour window cannot paper over an exhausted weekly one.
 *
 * confidence "unknown" returns HEALTHY on purpose, not CRITICAL: unknown
 * windows are all-zero, and a naive min() over them would read "no credits
 * left" and throttle every run for the whole duration of a monitoring
 * outage — the exact opposite of fail-open. An outage degrades to "run
 * normally, warn once".
 */
export function zoneFor(
  snapshot: BudgetSnapshot,
  thresholds: { preferFlashBelow: number; handoffReadyBelow: number; criticalBelow: number },
): BudgetZone {
  if (snapshot.confidence === "unknown") {
    return "HEALTHY";
  }
  const ratio = Math.min(snapshot.fiveHour.remainingRatio, snapshot.weekly.remainingRatio);
  if (ratio < thresholds.criticalBelow) {
    return "CRITICAL";
  }
  if (ratio < thresholds.handoffReadyBelow) {
    return "HANDOFF_READY";
  }
  if (ratio < thresholds.preferFlashBelow) {
    return "CONSERVE";
  }
  return "HEALTHY";
}

/**
 * The cache is a deduplication layer, never a source of truth: any problem
 * reading it (missing, unreadable, unparseable, wrong shape) reads as "no
 * cache" so the caller falls through to a live fetch.
 */
function readCachedSnapshot(home: string): BudgetSnapshot | null {
  const file = quotaCachePath(home);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.debug(`budget: unparseable quota cache at ${file} ignored`);
    return null;
  }
  if (!isSnapshotLike(parsed)) {
    logger.debug(`budget: quota cache at ${file} is not a snapshot, ignored`);
    return null;
  }
  return parsed;
}

/** Write failures are debug-logged, never thrown — a read-only home must not fail a run. */
function writeCachedSnapshot(home: string, snapshot: BudgetSnapshot): void {
  const file = quotaCachePath(home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot) + "\n", "utf8");
  } catch (error) {
    logger.debug(`budget: could not write quota cache (${errorMessage(error)})`);
  }
}

/**
 * "Parses and has the fields the consumers read": enough shape to trust the
 * cached numbers without duplicating the snapshot definition. Anything that
 * fails this was not written by this build.
 */
function isSnapshotLike(value: unknown): value is BudgetSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.confidence === "exact" ||
      candidate.confidence === "cached" ||
      candidate.confidence === "unknown") &&
    typeof candidate.fetchedAt === "string" &&
    isWindowLike(candidate.fiveHour) &&
    isWindowLike(candidate.weekly)
  );
}

function isWindowLike(value: unknown): value is BudgetWindow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const window = value as Record<string, unknown>;
  return (
    typeof window.used === "number" &&
    typeof window.limit === "number" &&
    typeof window.remaining === "number" &&
    typeof window.remainingRatio === "number" &&
    (window.resetAt === null || typeof window.resetAt === "string")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
