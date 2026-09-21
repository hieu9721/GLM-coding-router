import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyTask, estimateCost, isCleanMeasurement, readSamples, recordSample } from "../../src/budget/estimator.js";
import type { CostSample, TaskKind } from "../../src/budget/estimator.js";
import type { BudgetSnapshot } from "../../src/budget/manager.js";
import { costSamplesPath } from "../../src/core/paths.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

// Every test gets its own fake home so cost history never leaks between
// tests or into the real ~/.glm-coding-router.
let home: string;

beforeEach(() => {
  home = makeTempDir("glm-estimator-test-");
});

afterEach(() => {
  removeTempDir(home);
});

const MAIN = "glm-5.3";
const FAST = "glm-5.3-flash";

let seq = 0;

function sample(overrides: Partial<CostSample> = {}): CostSample {
  seq += 1;
  return {
    ts: `2026-09-21T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    taskKind: "crud",
    model: MAIN,
    repo: "api-server",
    credits: 10 * seq,
    turns: 5,
    tokensIn: 1000 * seq,
    tokensOut: 500 * seq,
    provider: "zai.zcode",
    role: "worker",
    validationOk: true,
    retries: 0,
    costClass: "subscription",
    ...overrides,
  };
}

/** isCleanMeasurement tests build snapshots directly; used/resetAt are what it reads. */
function snapshot(
  confidence: BudgetSnapshot["confidence"],
  fiveHour: { used?: number; resetAt?: string | null } = {},
): BudgetSnapshot {
  return {
    provider: "zai.zcode",
    unit: "credit",
    costClass: "subscription",
    fiveHour: {
      used: fiveHour.used ?? 100,
      limit: 2000,
      remaining: 1900,
      remainingRatio: 0.95,
      resetAt: fiveHour.resetAt === undefined ? "2026-09-21T12:00:00.000Z" : fiveHour.resetAt,
    },
    weekly: { used: 0, limit: 40000, remaining: 40000, remainingRatio: 1, resetAt: null },
    confidence,
    fetchedAt: "2026-09-21T10:00:00.000Z",
  };
}

describe("classifyTask (doc §13)", () => {
  it.each([
    // Priority first: "fix the failing test" is a bugfix, not a tests task.
    ["fix the failing test", "bugfix"],
    ["There is a BUG in checkout", "bugfix"],
    ["repair the login regression", "bugfix"],
    ["the worker crashed with error 41", "bugfix"],
    ["add coverage for the parser", "tests"],
    ["run vitest and report", "tests"],
    ["update the README badges", "docs"],
    ["add a docstring to parse()", "docs"],
    ["rename extractToString and clean up callers", "refactor"],
    ["migrate the config to zod v4", "refactor"],
    ["investigate why builds are slow", "explore"],
    ["analyze the flamegraph", "explore"],
    ["analyse the flamegraph", "explore"],
    ["create a /users endpoint with a schema", "crud"],
    ["build the import worker", "crud"],
    ["book a meeting room", "other"],
    ["", "other"],
  ])("%j -> %s", (prompt, kind) => {
    expect(classifyTask(prompt)).toBe(kind);
  });

  it("the priority order is bugfix > tests > docs > refactor > explore > crud", () => {
    // "investigate why builds are slow" contains the crud keyword "build";
    // explore outranks crud, so it must classify as explore.
    expect(classifyTask("investigate why builds are slow")).toBe("explore");
    // "add a docstring" contains the crud keyword "add"; docs outranks crud.
    expect(classifyTask("add a docstring to parse()")).toBe("docs");
  });
});

describe("cost samples (doc §13, hedge H4)", () => {
  it("recordSample appends one JSON line per sample and readSamples returns them in order", () => {
    const first = sample({ credits: 12 });
    const second = sample({ credits: 34, model: FAST });

    recordSample(home, first);
    recordSample(home, second);

    const text = readText(costSamplesPath(home));
    expect(text.split(/\r?\n/).filter((line) => line.trim() !== "")).toHaveLength(2);
    expect(readSamples(home)).toEqual([first, second]);
  });

  it("the H4 hedge fields survive the round-trip", () => {
    const reviewer = sample({
      role: "reviewer",
      validationOk: null,
      retries: 2,
      provider: "zai.zcode",
      costClass: "subscription",
    });
    recordSample(home, reviewer);
    expect(readSamples(home)).toEqual([reviewer]);
  });

  it("a missing samples file reads as empty history", () => {
    expect(readSamples(home)).toEqual([]);
  });

  it("malformed and non-sample lines are skipped, not fatal", () => {
    const good = sample({ credits: 7 });
    writeFileSyncAll(
      costSamplesPath(home),
      [
        JSON.stringify(good),
        "{ this is not json",
        JSON.stringify({ taskKind: "crud" }), // parses, but no model/credits
        "",
        JSON.stringify(sample({ credits: 9 })),
      ].join("\n") + "\n",
    );

    const samples = readSamples(home);
    expect(samples).toHaveLength(2);
    expect(samples.map((entry) => entry.credits)).toEqual([7, 9]);
  });

  it("recordSample never throws when the file cannot be written", () => {
    // cost-samples.jsonl as a directory: every append throws, which is the
    // read-only-home case in miniature. The run that earned the sample has
    // already done its work by now — losing the line must not fail it.
    fs.mkdirSync(costSamplesPath(home), { recursive: true });

    expect(() => recordSample(home, sample())).not.toThrow();
    expect(readSamples(home)).toEqual([]);
  });
});

describe("isCleanMeasurement (doc §13)", () => {
  it("a textbook clean measurement passes: exact + cached, same window, positive delta, sole run", () => {
    expect(
      isCleanMeasurement({
        startSnapshot: snapshot("exact", { used: 100 }),
        endSnapshot: snapshot("cached", { used: 112 }),
        activeRunCount: 1,
      }),
    ).toBe(true);
  });

  it("a zero delta is still clean — a run that cost nothing was measured, not corrupted", () => {
    expect(
      isCleanMeasurement({
        startSnapshot: snapshot("exact", { used: 100 }),
        endSnapshot: snapshot("exact", { used: 100 }),
        activeRunCount: 1,
      }),
    ).toBe(true);
  });

  it.each([
    [
      "start snapshot unknown",
      { startSnapshot: snapshot("unknown"), endSnapshot: snapshot("exact"), activeRunCount: 1 },
    ],
    [
      "end snapshot unknown",
      { startSnapshot: snapshot("exact"), endSnapshot: snapshot("unknown"), activeRunCount: 1 },
    ],
    [
      "five-hour window reset in between",
      {
        startSnapshot: snapshot("exact", { used: 100, resetAt: "2026-09-21T12:00:00.000Z" }),
        endSnapshot: snapshot("exact", { used: 100, resetAt: "2026-09-21T17:00:00.000Z" }),
        activeRunCount: 1,
      },
    ],
    [
      "reset timestamp appeared (null -> ISO)",
      {
        startSnapshot: snapshot("exact", { used: 100, resetAt: null }),
        endSnapshot: snapshot("exact", { used: 100, resetAt: "2026-09-21T12:00:00.000Z" }),
        activeRunCount: 1,
      },
    ],
    [
      "negative credit delta",
      { startSnapshot: snapshot("exact", { used: 200 }), endSnapshot: snapshot("exact", { used: 100 }), activeRunCount: 1 },
    ],
    ["no active run at all", { startSnapshot: snapshot("exact"), endSnapshot: snapshot("exact"), activeRunCount: 0 }],
    [
      "concurrent runs make attribution meaningless",
      { startSnapshot: snapshot("exact"), endSnapshot: snapshot("exact"), activeRunCount: 2 },
    ],
  ])("rejects: %s", (_label, input) => {
    expect(isCleanMeasurement(input)).toBe(false);
  });
});

describe("estimateCost (doc §13)", () => {
  it.each([
    ["explore", 15, 28],
    ["crud", 42, 66],
    ["tests", 30, 50],
    ["docs", 12, 22],
    ["refactor", 45, 75],
    ["bugfix", 35, 60],
    ["other", 35, 60],
  ])("baseline for %s on the main model is p50 %i / p90 %i", (kind, p50, p90) => {
    const estimate = estimateCost(home, kind as TaskKind, MAIN, FAST);
    expect(estimate).toEqual({ p50, p90, samples: 0, source: "baseline" });
  });

  it("the fast model is 40% of the main row, rounded", () => {
    expect(estimateCost(home, "crud", FAST, FAST)).toEqual({ p50: 17, p90: 26, samples: 0, source: "baseline" });
    expect(estimateCost(home, "docs", FAST, FAST)).toEqual({ p50: 5, p90: 9, samples: 0, source: "baseline" });
    expect(estimateCost(home, "explore", FAST, FAST)).toEqual({ p50: 6, p90: 11, samples: 0, source: "baseline" });
  });

  it("any model that is not fastModel is treated as main", () => {
    expect(estimateCost(home, "crud", "glm-4.6", FAST).p50).toBe(42);
  });

  it("under 5 matching samples the baseline still answers", () => {
    for (const credits of [10, 20, 30, 40]) {
      recordSample(home, sample({ credits }));
    }
    expect(estimateCost(home, "crud", MAIN, FAST)).toEqual({ p50: 42, p90: 66, samples: 0, source: "baseline" });
  });

  it("history wins at 5 samples with nearest-rank percentiles over ascending credits", () => {
    for (const credits of [50, 10, 40, 20, 30]) {
      recordSample(home, sample({ credits }));
    }
    // Sorted: 10 20 30 40 50. p50 = ceil(0.5*5)-1 = index 2 -> 30.
    // p90 = ceil(0.9*5)-1 = index 4 -> 50 (the maximum, by design).
    expect(estimateCost(home, "crud", MAIN, FAST)).toEqual({ p50: 30, p90: 50, samples: 5, source: "history" });
  });

  it("nearest-rank at n=6 does not interpolate between samples", () => {
    for (const credits of [6, 5, 4, 3, 2, 1]) {
      recordSample(home, sample({ credits }));
    }
    // Sorted: 1..6. p50 = ceil(3)-1 = index 2 -> 3. p90 = ceil(5.4)-1 = index 5 -> 6.
    expect(estimateCost(home, "crud", MAIN, FAST)).toEqual({ p50: 3, p90: 6, samples: 6, source: "history" });
  });

  it("matching requires BOTH taskKind and model", () => {
    for (const credits of [10, 20, 30, 40, 50]) {
      recordSample(home, sample({ credits }));
    }
    for (const credits of [11, 21, 31, 41]) {
      recordSample(home, sample({ credits, model: FAST }));
    }
    for (const credits of [12, 22, 32, 42]) {
      recordSample(home, sample({ credits, taskKind: "tests" as TaskKind }));
    }

    // 5 crud/main samples: history.
    expect(estimateCost(home, "crud", MAIN, FAST).source).toBe("history");
    // 4 crud/fast and 4 tests/main samples: below the threshold, baseline.
    expect(estimateCost(home, "crud", FAST, FAST)).toEqual({ p50: 17, p90: 26, samples: 0, source: "baseline" });
    expect(estimateCost(home, "tests", MAIN, FAST)).toEqual({ p50: 30, p90: 50, samples: 0, source: "baseline" });
  });
});

describe("classifyTask matches whole words, not substrings (regression)", () => {
  // The worker that wrote this module flagged the ambiguity instead of hiding
  // it: with substring matching "docker" read as docs and "fixture" as bugfix.
  // That is not cosmetic — the kind picks the cost row behind `wouldRefuse`,
  // which is the evidence D3 says 2.1's decision will be argued from.
  it("does not let a longer word trigger a shorter keyword", () => {
    // "docker" no longer reads as the docs keyword "doc"; "add" makes it crud.
    expect(classifyTask("Add a docker-compose file for local dev")).toBe("crud");
    // "fixture" no longer reads as the bugfix keyword "fix". It lands on crud
    // via "write" rather than on tests, because "fixture" is not itself a
    // tests keyword — the point here is only that it stopped being a bugfix.
    expect(classifyTask("Write a fixture for the parser")).toBe("crud");
  });

  it("still matches the listed plural and derived forms", () => {
    expect(classifyTask("Update the docs")).toBe("docs");
    expect(classifyTask("Fixing the broken import")).toBe("bugfix");
    expect(classifyTask("Refactoring the worktree helpers")).toBe("refactor");
    expect(classifyTask("Add tests for the adapter")).toBe("tests");
  });

  it("keeps the priority order: repair beats coverage", () => {
    expect(classifyTask("fix the failing test")).toBe("bugfix");
  });

  it("a multi-word keyword still matches", () => {
    expect(classifyTask("clean up the dead branches")).toBe("refactor");
  });
});
