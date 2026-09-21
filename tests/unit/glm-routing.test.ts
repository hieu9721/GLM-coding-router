import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideRoute } from "../../src/routing/glm-routing.js";
import type { RouteDecision } from "../../src/routing/glm-routing.js";
import type { BudgetSnapshot, BudgetWindow } from "../../src/budget/manager.js";
import type { CostEstimate } from "../../src/budget/estimator.js";
import { defaultConfig } from "../../src/core/config.js";
import type { RouterConfig } from "../../src/core/config.js";
import { Errors, ExitCode, formatGlmError } from "../../src/core/errors.js";

/**
 * Phase E part 2 (specs/v2-architecture.md): decideRoute is pure, so this is
 * the cheapest place to be exhaustive — every input is an argument, no fake
 * home, no clock. Numbers mirror the shipped defaults: thresholds
 * 0.30/0.15/0.08, reserveRatio 0.10, safetyFactor 1.3.
 */
const DEFAULTS = defaultConfig();
const { main: MAIN, fast: FAST } = DEFAULTS.models;
const SAFETY = DEFAULTS.routing.safetyFactor;

/** Baseline-shaped estimates (doc §13 crud row); the router only reads p90. */
function estimate(p90: number): CostEstimate {
  return { p50: Math.round(p90 * 0.6), p90, samples: 0, source: "baseline" };
}
const BASE = { main: estimate(66), fast: estimate(26) };

/** Same limit for both windows unless a case says otherwise, so ratio alone picks the binding one. */
const LIMIT = 10_000;

function window(ratio: number, limit: number = LIMIT): BudgetWindow {
  const remaining = limit * ratio;
  return {
    used: limit - remaining,
    limit,
    remaining,
    remainingRatio: ratio,
    resetAt: "2026-09-21T12:00:00.000Z",
  };
}

function snapshot(
  fiveHourRatio: number,
  weeklyRatio: number,
  confidence: BudgetSnapshot["confidence"] = "exact",
): BudgetSnapshot {
  return makeSnapshot(window(fiveHourRatio), window(weeklyRatio), confidence);
}

function makeSnapshot(
  fiveHour: BudgetWindow,
  weekly: BudgetWindow,
  confidence: BudgetSnapshot["confidence"] = "exact",
): BudgetSnapshot {
  return {
    provider: "zai.zcode",
    unit: "credit",
    costClass: "subscription",
    fiveHour,
    weekly,
    confidence,
    fetchedAt: "2026-09-21T10:00:00.000Z",
  };
}

function config(routing: Partial<RouterConfig["routing"]> = {}): RouterConfig {
  return { ...defaultConfig(), routing: { ...DEFAULTS.routing, ...routing } };
}

/** decideRoute with the defaults every case below starts from. */
function decide(overrides: Partial<Parameters<typeof decideRoute>[0]>): RouteDecision {
  return decideRoute({ snapshot: snapshot(0.5, 0.5), estimates: BASE, config: config(), ...overrides });
}

describe("decideRoute (specs/v2-architecture.md Phase E)", () => {
  describe("zone × --model pin (doc §12)", () => {
    const ZONES = [
      { zone: "HEALTHY", ratio: 0.5 }, // ≥ preferFlashBelow (0.30)
      { zone: "CONSERVE", ratio: 0.2 }, // < 0.30, ≥ handoffReadyBelow (0.15)
      { zone: "HANDOFF_READY", ratio: 0.12 }, // < 0.15, ≥ criticalBelow (0.08)
      { zone: "CRITICAL", ratio: 0.05 }, // < 0.08
    ] as const;

    it.each(ZONES)("zone $zone, no pin: the zone picks the model", ({ zone, ratio }) => {
      const d = decide({ snapshot: snapshot(ratio, ratio) });
      expect(d.zone).toBe(zone);
      expect(d.model).toBe(zone === "HEALTHY" ? MAIN : FAST);
      expect(d.action).toBe(zone === "HEALTHY" ? "run" : "downgrade");
      // CRITICAL under the shipped defaults also trips the neither-fits arm
      // (usable = max(0, 500 − 1000) = 0 because reserveRatio 0.10 > critical
      // -Below 0.08), but both arms point the same way, so the row stays pure
      // zone coverage: wouldRefuse is exactly "is this CRITICAL?".
      expect(d.wouldRefuse).toBe(zone === "CRITICAL");
      // estimatedCost is the CHOSEN model's p90 × safetyFactor…
      expect(d.estimatedCost).toBe((zone === "HEALTHY" ? BASE.main.p90 : BASE.fast.p90) * SAFETY);
      // …and the model is always a real name out of config.models.
      expect([MAIN, FAST]).toContain(d.model);
      expect(d.reason).toContain(zone);
    });

    it.each(ZONES)("zone $zone, --model main: the pin overrides the zone", ({ zone, ratio }) => {
      const d = decide({ snapshot: snapshot(ratio, ratio), requestedModel: "main" });
      expect(d.model).toBe(MAIN);
      expect(d.action).toBe("run"); // a pin is never a downgrade…
      expect(d.wouldRefuse).toBe(zone === "CRITICAL"); // …and never a refusal bypass
      expect(d.reason).toContain("pinned");
    });

    it.each(ZONES)("zone $zone, --model fast: the pin overrides the zone", ({ zone, ratio }) => {
      const d = decide({ snapshot: snapshot(ratio, ratio), requestedModel: "fast" });
      expect(d.model).toBe(FAST);
      expect(d.action).toBe("run");
      expect(d.wouldRefuse).toBe(zone === "CRITICAL");
    });
  });

  describe("fail-open: a monitoring outage must never block work", () => {
    it("confidence unknown → run, requested model, wouldRefuse false — even with CRITICAL numbers", () => {
      // zoneFor itself returns HEALTHY for unknown (the manager's fail-open
      // trap); the ratios below would be CRITICAL if the numbers were trusted.
      const d = decide({ snapshot: snapshot(0.01, 0.01, "unknown") });
      expect(d.action).toBe("run");
      expect(d.model).toBe(MAIN);
      expect(d.zone).toBe("HEALTHY");
      expect(d.wouldRefuse).toBe(false);
    });

    it("confidence unknown + --model fast → still runs the pinned model, never a downgrade", () => {
      const d = decide({ snapshot: snapshot(0.01, 0.01, "unknown"), requestedModel: "fast" });
      expect(d.action).toBe("run");
      expect(d.model).toBe(FAST);
      expect(d.wouldRefuse).toBe(false);
    });

    it("quotaAware false → same fail-open shape, with the zone still reported as computed", () => {
      const d = decide({ config: config({ quotaAware: false }), snapshot: snapshot(0.05, 0.05) });
      expect(d.action).toBe("run");
      expect(d.model).toBe(MAIN); // rule 1: main, not the zone's fast
      expect(d.zone).toBe("CRITICAL");
      expect(d.wouldRefuse).toBe(false);
    });

    it("quotaAware false + --model fast → runs fast as pinned", () => {
      const d = decide({
        config: config({ quotaAware: false }),
        snapshot: snapshot(0.05, 0.05),
        requestedModel: "fast",
      });
      expect(d.action).toBe("run");
      expect(d.model).toBe(FAST);
      expect(d.wouldRefuse).toBe(false);
    });
  });

  describe("D3: the refusal is reported, not enforced, in 2.0.0", () => {
    it("refuseOnCritical false (the shipped default) + CRITICAL → NOT return_to_parent, but wouldRefuse IS true", () => {
      const d = decide({ snapshot: snapshot(0.05, 0.05) }); // default config
      expect(d.zone).toBe("CRITICAL");
      expect(d.wouldRefuse).toBe(true);
      expect(d.action).not.toBe("return_to_parent");
      expect(d.action).toBe("downgrade"); // observe and downgrade, never refuse
    });

    it("refuseOnCritical true + CRITICAL → return_to_parent", () => {
      const d = decide({ config: config({ refuseOnCritical: true }), snapshot: snapshot(0.05, 0.05) });
      expect(d.action).toBe("return_to_parent");
      expect(d.wouldRefuse).toBe(true);
      expect(d.reason).toContain("CRITICAL");
    });

    it("refuseOnCritical true + CRITICAL + force → not refused; still downgrades to fast", () => {
      const d = decide({
        config: config({ refuseOnCritical: true }),
        snapshot: snapshot(0.05, 0.05),
        force: true,
      });
      expect(d.action).toBe("downgrade");
      expect(d.wouldRefuse).toBe(true); // the flag reports what WOULD have happened
    });

    it("a pin does not bypass the enforced refusal (rule 5) — only --force does", () => {
      const d = decide({
        config: config({ refuseOnCritical: true }),
        snapshot: snapshot(0.05, 0.05),
        requestedModel: "main",
      });
      expect(d.action).toBe("return_to_parent");
      expect(d.model).toBe(MAIN); // the model that would have run
    });

    it("refuseOnCritical true also enforces the neither-model-fits arm, far from any CRITICAL threshold", () => {
      // HEALTHY zone, tiny window: both p90s overflow usable, so rule 6(b)
      // fires at ratio 0.5 — proof the flag governs both refusal arms.
      const tiny = makeSnapshot(window(0.5, 60), window(0.5, 60));
      const d = decide({ config: config({ refuseOnCritical: true }), snapshot: tiny });
      expect(d.zone).toBe("HEALTHY");
      expect(d.wouldRefuse).toBe(true);
      expect(d.action).toBe("return_to_parent");
    });
  });

  describe("doc §14: always try Flash before giving up", () => {
    // limit 100 → usable = 50 − 10 = 40: fast (26 × 1.3 = 33.8) fits, main
    // (66 × 1.3 = 85.8) does not. HEALTHY, so only the estimate — not the
    // zone — can cause the fast choice here.
    const betweenModels = makeSnapshot(window(0.5, 100), window(0.5, 100));

    it("fits on fast but not on main → wouldRefuse false, fast chosen, downgrade", () => {
      const d = decide({ snapshot: betweenModels });
      expect(d.zone).toBe("HEALTHY");
      expect(d.model).toBe(FAST);
      expect(d.action).toBe("downgrade");
      expect(d.wouldRefuse).toBe(false);
      expect(d.estimatedCost).toBe(BASE.fast.p90 * SAFETY); // the chosen model's cost
      expect(d.reason).toContain("fast");
    });

    it("a pin gets no affordability fallback: pinned main runs main, wouldRefuse still false", () => {
      const d = decide({ snapshot: betweenModels, requestedModel: "main" });
      expect(d.model).toBe(MAIN);
      expect(d.action).toBe("run");
      expect(d.wouldRefuse).toBe(false); // fast still fits, so no refusal either
    });

    it("fits on neither → wouldRefuse true even in HEALTHY; D3 default still runs it", () => {
      const tiny = makeSnapshot(window(0.5, 60), window(0.5, 60)); // usable 24 < 33.8
      const d = decide({ snapshot: tiny });
      expect(d.zone).toBe("HEALTHY");
      expect(d.wouldRefuse).toBe(true);
      expect(d.action).toBe("run"); // reported, not enforced
      expect(d.model).toBe(MAIN); // no fallback: fast does not fit either
    });
  });

  describe("the binding window is the lower-ratio one (rule 3)", () => {
    it("a healthy 5-hour window cannot paper over an exhausted weekly one", () => {
      const d = decide({ snapshot: makeSnapshot(window(0.5), window(0.02)) });
      expect(d.zone).toBe("CRITICAL"); // min(0.5, 0.02) < 0.08
      expect(d.wouldRefuse).toBe(true);
      // usable comes from the WEEKLY window: 200 remaining − 1000 reserve, clamped.
      expect(d.usableBudget).toBe(0);
    });

    it("and the mirror: an exhausted 5-hour window binds over a healthy weekly one", () => {
      const d = decide({ snapshot: makeSnapshot(window(0.02), window(0.5)) });
      expect(d.zone).toBe("CRITICAL");
      expect(d.usableBudget).toBe(0);
    });

    it("usableBudget tracks the binding window's own limit, never the other window's numbers", () => {
      // fiveHour binds (0.12 < 0.50): reserve is 10% of the FIVE-HOUR limit
      // (100), not of the weekly one (10_000). Reading weekly instead would
      // report 40_000 usable.
      const d = decide({ snapshot: makeSnapshot(window(0.12, 1_000), window(0.5, 100_000)) });
      expect(d.zone).toBe("HANDOFF_READY");
      expect(d.usableBudget).toBe(1_000 * 0.12 - 1_000 * 0.1);
    });
  });

  describe("usableBudget arithmetic (doc §11)", () => {
    it("reserve = reserveRatio × binding limit; usable = remaining − reserve", () => {
      const d = decide({ snapshot: snapshot(0.5, 0.5) });
      expect(d.usableBudget).toBe(LIMIT * 0.5 - LIMIT * 0.1);
    });

    it("never goes negative when the reserve exceeds what is left", () => {
      // fiveHour binds: 500 remaining − 1000 reserve → 0, not −500.
      const d = decide({ snapshot: snapshot(0.05, 0.5) });
      expect(d.usableBudget).toBe(0);
    });
  });

  describe("purity: the router must stay a pure function", () => {
    // The orchestrator wires fs/fetch/clock/logging around this module; if the
    // module itself ever reaches for them, preflight stops being testable as a
    // table and the fail-open contract gets hidden behind side effects.
    const source = readFileSync(
      fileURLToPath(new URL("../../src/routing/glm-routing.ts", import.meta.url)),
      "utf8",
    );

    it("imports no fs/os/path, no logger, and never exits the process", () => {
      expect(source).not.toMatch(/from\s+"(node:fs|node:os|node:path|[^"]*logging(\.js)?)"/);
      expect(source).not.toMatch(/\bprocess\.exit\b/);
    });
  });
});

describe("Phase E error factories (specs/v2-architecture.md Phase E, D2)", () => {
  it("quotaInsufficient: name, exit 41, both numbers in credits, actionable hint", () => {
    const error = Errors.quotaInsufficient(85.8, 40);
    expect(error.codeName).toBe("QUOTA_INSUFFICIENT");
    expect(error.exitCode).toBe(41);
    expect(error.exitCode).toBe(ExitCode.QuotaInsufficient);
    expect(error.message).toContain("85.8");
    expect(error.message).toContain("40");
    expect(error.message).toContain("credit");
    expect(error.hint.join("\n")).toContain("reset");
    expect(error.hint.join("\n")).toContain("--force");
  });

  it("handoffRequired: name, exit 42, names the bundle as where to pick the work up", () => {
    const error = Errors.handoffRequired("quota exhausted mid-run", "runs/run_x/handoff");
    expect(error.codeName).toBe("HANDOFF_REQUIRED");
    expect(error.exitCode).toBe(ExitCode.HandoffRequired);
    expect(error.message).toContain("quota exhausted mid-run");
    expect(error.hint.join("\n")).toContain("unfinished");
    expect(error.hint.join("\n")).toContain("runs/run_x/handoff");
  });

  it("handoffRequired without a bundle says preserved, without naming a path", () => {
    const error = Errors.handoffRequired("quota exhausted mid-run");
    expect(error.hint.join("\n")).toContain("unfinished");
    expect(error.hint.join("\n")).not.toContain("Pick it up");
  });

  it("both render in the ERROR [NAME] format (spec §36)", () => {
    expect(formatGlmError(Errors.quotaInsufficient(90, 50))).toContain("ERROR [QUOTA_INSUFFICIENT]");
    expect(formatGlmError(Errors.handoffRequired("quota exhausted mid-run"))).toContain(
      "ERROR [HANDOFF_REQUIRED]",
    );
  });
});
