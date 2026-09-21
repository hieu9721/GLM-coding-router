import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchBudget, zoneFor } from "../../src/budget/manager.js";
import type { BudgetSnapshot, BudgetWindow } from "../../src/budget/manager.js";
import type { ZaiLimit } from "../../src/core/zai-quota.js";
import { quotaCachePath } from "../../src/core/paths.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

// Every test gets its own fake home (never the real ~/.glm-coding-router)
// and a frozen, advanceable clock so cache-TTL math is exact.
let home: string;
let clockMs: number;
const now = (): Date => new Date(clockMs);

beforeEach(() => {
  home = makeTempDir("glm-budget-test-");
  clockMs = Date.parse("2026-09-21T10:00:00.000Z");
});

afterEach(() => {
  removeTempDir(home);
});

// The payload shape verified live against the monitor endpoint
// (specs/usage.md), including its arithmetic gap: 912 + 1087 = 1999 of 2000.
// The server's remaining is authoritative; the manager must not recompute it.
const FIVE_HOUR: ZaiLimit = {
  type: "CREDIT_LIMIT",
  unit: 3,
  number: 5,
  usage: 2000,
  currentValue: 912,
  remaining: 1087,
  percentage: 45,
  nextResetTime: Date.parse("2026-09-21T12:00:00.000Z"),
};

const WEEKLY: ZaiLimit = {
  type: "CREDIT_LIMIT",
  unit: 6,
  number: 1,
  usage: 40000,
  currentValue: 21000,
  remaining: 19000,
  percentage: 52,
  nextResetTime: Date.parse("2026-09-25T12:00:00.000Z"),
};

/** A fake fetch that always answers with the given limits and counts calls. */
function quotaFetch(limits: readonly ZaiLimit[], counter?: { calls: number }): typeof fetch {
  return (async () => {
    if (counter) {
      counter.calls += 1;
    }
    return new Response(
      JSON.stringify({ code: 200, msg: "ok", success: true, data: { level: "lite", limits } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

const ZERO_WINDOW: BudgetWindow = { used: 0, limit: 0, remaining: 0, remainingRatio: 0, resetAt: null };

/** Zone tests build snapshots directly; ratio is all zoneFor reads. */
function snapshotWith(
  ratios: { fiveHour?: number; weekly?: number },
  confidence: BudgetSnapshot["confidence"] = "exact",
): BudgetSnapshot {
  const window = (ratio: number): BudgetWindow => ({
    used: 1 - ratio,
    limit: 1,
    remaining: ratio,
    remainingRatio: ratio,
    resetAt: "2026-09-21T12:00:00.000Z",
  });
  return {
    provider: "zai.zcode",
    unit: "credit",
    costClass: "subscription",
    fiveHour: window(ratios.fiveHour ?? 1),
    weekly: window(ratios.weekly ?? 1),
    confidence,
    fetchedAt: "2026-09-21T10:00:00.000Z",
  };
}

describe("fetchBudget (specs/v2-architecture.md Phase E)", () => {
  it("maps the live payload to both windows without recomputing the server's remaining", async () => {
    const snapshot = await fetchBudget({ home, key: "k", fetchImpl: quotaFetch([FIVE_HOUR, WEEKLY]), now });

    expect(snapshot.provider).toBe("zai.zcode");
    expect(snapshot.unit).toBe("credit");
    expect(snapshot.costClass).toBe("subscription");
    expect(snapshot.confidence).toBe("exact");
    expect(snapshot.fetchedAt).toBe("2026-09-21T10:00:00.000Z");
    // 1087 is the server's number even though 2000 - 912 = 1088.
    expect(snapshot.fiveHour).toEqual({
      used: 912,
      limit: 2000,
      remaining: 1087,
      remainingRatio: 1087 / 2000,
      resetAt: "2026-09-21T12:00:00.000Z",
    });
    expect(snapshot.weekly).toEqual({
      used: 21000,
      limit: 40000,
      remaining: 19000,
      remainingRatio: 19000 / 40000,
      resetAt: "2026-09-25T12:00:00.000Z",
    });
  });

  it("falls back to limit - used only when the server omits remaining", async () => {
    const noRemaining = { ...FIVE_HOUR, remaining: undefined };
    const snapshot = await fetchBudget({ home, key: "k", fetchImpl: quotaFetch([noRemaining, WEEKLY]), now });

    expect(snapshot.fiveHour.remaining).toBe(2000 - 912);
    expect(snapshot.fiveHour.remainingRatio).toBe((2000 - 912) / 2000);
  });

  it("a half-answer is unknown with zero windows, not an exact one", async () => {
    // Rewritten in review: this test used to assert only that the ABSENT
    // window mapped to zeros, which a fabricated-zero "exact" snapshot and an
    // honest "unknown" one both satisfy — so it could not tell the defect
    // from the fix. The confidence is the part that matters, because that is
    // what stops zoneFor reading a window we never received as CRITICAL.
    const onlyWeekly = await fetchBudget({ home, key: "k", fetchImpl: quotaFetch([WEEKLY]), now });
    expect(onlyWeekly.confidence).toBe("unknown");
    expect(onlyWeekly.fiveHour).toEqual(ZERO_WINDOW);
    expect(onlyWeekly.weekly).toEqual(ZERO_WINDOW);

    // A separate home: the first call's cache would otherwise answer this
    // with the snapshot it just stored — the cache is doing its job.
    const otherHome = makeTempDir("glm-budget-test-");
    try {
      const onlyFiveHour = await fetchBudget({ home: otherHome, key: "k", fetchImpl: quotaFetch([FIVE_HOUR]), now });
      expect(onlyFiveHour.confidence).toBe("unknown");
      expect(onlyFiveHour.weekly).toEqual(ZERO_WINDOW);
    } finally {
      removeTempDir(otherHome);
    }
  });

  it("a zero or missing limit yields ratio 0 — never NaN, never Infinity", async () => {
    const zeroLimit: ZaiLimit = { ...FIVE_HOUR, usage: 0, currentValue: 5, remaining: 0 };
    const missingLimit: ZaiLimit = { ...FIVE_HOUR, usage: undefined, currentValue: 5, remaining: 3 };

    for (const limit of [zeroLimit, missingLimit]) {
      const snapshot = await fetchBudget({ home, key: "k", fetchImpl: quotaFetch([limit, WEEKLY]), now });
      expect(snapshot.fiveHour.remainingRatio).toBe(0);
      expect(Number.isFinite(snapshot.fiveHour.remainingRatio)).toBe(true);
    }
  });

  it("writes the cache file and serves a burst from it with ONE request", async () => {
    const counter = { calls: 0 };
    const deps = { home, key: "k", fetchImpl: quotaFetch([FIVE_HOUR, WEEKLY], counter), now };

    const first = await fetchBudget(deps);
    clockMs += 10_000; // well inside the 60 s default TTL
    const second = await fetchBudget(deps);

    expect(counter.calls).toBe(1);
    expect(first.confidence).toBe("exact");
    expect(second.confidence).toBe("cached");
    // A cached read keeps the fetch-time numbers and timestamp, not the read's.
    expect(second.fiveHour).toEqual(first.fiveHour);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    // The stored entry is the exact fetch; "cached" is a read-time verdict.
    const stored = JSON.parse(readText(quotaCachePath(home))) as BudgetSnapshot;
    expect(stored).toEqual(first);
  });

  it("a cache entry older than the TTL is re-fetched", async () => {
    const counter = { calls: 0 };
    const deps = { home, key: "k", fetchImpl: quotaFetch([FIVE_HOUR, WEEKLY], counter), now, ttlSec: 60 };

    await fetchBudget(deps);
    clockMs += 59_999;
    expect((await fetchBudget(deps)).confidence).toBe("cached");
    expect(counter.calls).toBe(1);

    clockMs += 2; // now 61 s past the fetch
    const expired = await fetchBudget(deps);
    expect(expired.confidence).toBe("exact");
    expect(counter.calls).toBe(2);
    expect(expired.fetchedAt).toBe(new Date(clockMs).toISOString());
  });

  it("refresh: true bypasses a fresh cache (what --refresh-quota drives) and rewrites it", async () => {
    const counter = { calls: 0 };
    const deps = { home, key: "k", fetchImpl: quotaFetch([FIVE_HOUR, WEEKLY], counter), now };

    await fetchBudget(deps);
    clockMs += 1_000;
    const refreshed = await fetchBudget({ ...deps, refresh: true });

    expect(refreshed.confidence).toBe("exact");
    expect(refreshed.fetchedAt).toBe(new Date(clockMs).toISOString());
    expect(counter.calls).toBe(2);

    // The refreshed entry itself is cached: the next normal read uses it.
    const after = await fetchBudget(deps);
    expect(after.confidence).toBe("cached");
    expect(after.fetchedAt).toBe(refreshed.fetchedAt);
    expect(counter.calls).toBe(2);
  });

  it("no key yields an unknown, all-zero snapshot without any request", async () => {
    const counter = { calls: 0 };

    const snapshot = await fetchBudget({ home, fetchImpl: quotaFetch([FIVE_HOUR, WEEKLY], counter), now });

    expect(counter.calls).toBe(0);
    expect(snapshot.confidence).toBe("unknown");
    expect(snapshot.fiveHour).toEqual(ZERO_WINDOW);
    expect(snapshot.weekly).toEqual(ZERO_WINDOW);
  });

  it.each([
    ["endpoint down", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch],
    ["HTTP error", (async () => new Response("nope", { status: 500 })) as typeof fetch],
    ["non-JSON body", (async () => new Response("not json at all", { status: 200 })) as typeof fetch],
    ["rejected body", (async () =>
      new Response(JSON.stringify({ code: 401, msg: "unauthorized", success: false }), { status: 200 })) as typeof fetch],
  ])("fail-open on %s: unknown, all-zero, resolved not rejected", async (_label, fetchImpl) => {
    const snapshot = await fetchBudget({ home, key: "k", fetchImpl, now });

    expect(snapshot.confidence).toBe("unknown");
    expect(snapshot.fiveHour).toEqual(ZERO_WINDOW);
    expect(snapshot.weekly).toEqual(ZERO_WINDOW);
  });

  it("an unparseable cache falls through: unknown without a key, exact with one", async () => {
    writeFileSyncAll(quotaCachePath(home), "{ this is not json");

    const noKey = await fetchBudget({ home, now });
    expect(noKey.confidence).toBe("unknown");

    const counter = { calls: 0 };
    const live = await fetchBudget({ home, key: "k", fetchImpl: quotaFetch([FIVE_HOUR, WEEKLY], counter), now });
    expect(live.confidence).toBe("exact");
    expect(counter.calls).toBe(1);
  });

  it("a fresh cache answers even when the key is gone, so key-resolution hiccups cost nothing", async () => {
    const counter = { calls: 0 };
    await fetchBudget({ home, key: "k", fetchImpl: quotaFetch([FIVE_HOUR, WEEKLY], counter), now });
    clockMs += 5_000;

    const cached = await fetchBudget({ home, fetchImpl: quotaFetch([FIVE_HOUR, WEEKLY], counter), now });

    expect(cached.confidence).toBe("cached");
    expect(counter.calls).toBe(1);
  });

  it("an unwritable cache location never fails the fetch", async () => {
    // quota.json as a directory: every write attempt throws, which is the
    // read-only-home case in miniature.
    fs.mkdirSync(quotaCachePath(home), { recursive: true });

    const snapshot = await fetchBudget({ home, key: "k", fetchImpl: quotaFetch([FIVE_HOUR, WEEKLY]), now });

    expect(snapshot.confidence).toBe("exact");
    expect(snapshot.fiveHour.used).toBe(912);
  });
});

describe("zoneFor (specs/v2-architecture.md Phase E)", () => {
  const THRESHOLDS = { preferFlashBelow: 0.3, handoffReadyBelow: 0.15, criticalBelow: 0.08 };

  it.each([
    [1.0, "HEALTHY"],
    [0.5, "HEALTHY"],
    [0.3, "HEALTHY"], // at preferFlashBelow — zones are strict-below
    [0.299, "CONSERVE"],
    [0.2, "CONSERVE"],
    [0.15, "CONSERVE"], // at handoffReadyBelow
    [0.1, "HANDOFF_READY"],
    [0.08, "HANDOFF_READY"], // at criticalBelow
    [0.079, "CRITICAL"],
    [0.01, "CRITICAL"],
  ])("ratio %f -> %s", (ratio, zone) => {
    expect(zoneFor(snapshotWith({ fiveHour: ratio, weekly: ratio }), THRESHOLDS)).toBe(zone);
  });

  it("the worst window wins in both directions", () => {
    expect(zoneFor(snapshotWith({ fiveHour: 0.5, weekly: 0.05 }), THRESHOLDS)).toBe("CRITICAL");
    expect(zoneFor(snapshotWith({ fiveHour: 0.05, weekly: 0.5 }), THRESHOLDS)).toBe("CRITICAL");
    expect(zoneFor(snapshotWith({ fiveHour: 0.5, weekly: 0.2 }), THRESHOLDS)).toBe("CONSERVE");
  });

  it("confidence \"unknown\" is HEALTHY, not CRITICAL — the fail-open trap", () => {
    // Unknown windows are all-zero; a naive min() would read that as
    // "no credits left" and throttle every run during a monitoring outage.
    expect(zoneFor(snapshotWith({ fiveHour: 0, weekly: 0 }, "unknown"), THRESHOLDS)).toBe("HEALTHY");
  });

  it("thresholds come from the caller, so config can retune the zones", () => {
    const aggressive = { preferFlashBelow: 0.9, handoffReadyBelow: 0.5, criticalBelow: 0.1 };
    expect(zoneFor(snapshotWith({ fiveHour: 0.95 }), aggressive)).toBe("HEALTHY");
    expect(zoneFor(snapshotWith({ fiveHour: 0.6 }), aggressive)).toBe("CONSERVE");
    expect(zoneFor(snapshotWith({ fiveHour: 0.3 }), aggressive)).toBe("HANDOFF_READY");
    expect(zoneFor(snapshotWith({ fiveHour: 0.05 }), aggressive)).toBe("CRITICAL");
  });
});

describe("fetchBudget rejects a payload it cannot route on (regression)", () => {
  // Found in review, not by the worker's own tests: a 200 response carrying no
  // recognizable window mapped to an "exact" all-zero snapshot, which zoneFor
  // reads as CRITICAL. That silently downgrades and warns on every run today,
  // and refuses every run once refuseOnCritical flips in 2.1 — on a payload
  // that told us nothing. "(no quota windows reported)" is a state usage.ts
  // already renders, so this is a real endpoint state, not a hypothetical.
  const THRESHOLDS = { preferFlashBelow: 0.3, handoffReadyBelow: 0.15, criticalBelow: 0.08 };

  it("an empty limits array is unknown/HEALTHY, never exact/CRITICAL", async () => {
    const snapshot = await fetchBudget({ home, key: "k", fetchImpl: quotaFetch([]), now });

    expect(snapshot.confidence).toBe("unknown");
    expect(zoneFor(snapshot, THRESHOLDS)).toBe("HEALTHY");
  });

  it("a half-answer (5-hour window only) is unknown too — the router needs the pair", async () => {
    // min() over a present window and a fabricated zero one is meaningless:
    // the binding window it picks would always be the one we never received.
    const snapshot = await fetchBudget({ home, key: "k", fetchImpl: quotaFetch([FIVE_HOUR]), now });

    expect(snapshot.confidence).toBe("unknown");
    expect(zoneFor(snapshot, THRESHOLDS)).toBe("HEALTHY");
  });

  it("still maps the real both-windows payload as exact", async () => {
    // The guard must reject only what it cannot route on.
    const snapshot = await fetchBudget({ home, key: "k", fetchImpl: quotaFetch([FIVE_HOUR, WEEKLY]), now });

    expect(snapshot.confidence).toBe("exact");
    expect(snapshot.fiveHour.remaining).toBe(1087);
  });
});
