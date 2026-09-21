import fs from "node:fs";
import path from "node:path";
import { logger } from "../core/logging.js";
import { costSamplesPath } from "../core/paths.js";
import type { BudgetSnapshot } from "./manager.js";

export type TaskKind = "explore" | "crud" | "tests" | "docs" | "refactor" | "bugfix" | "other";

/**
 * Priority-ordered keyword table: the first row with a case-insensitive WHOLE
 * WORD match wins, which is what makes "fix the failing test" a bugfix rather
 * than a tests task — repair beats coverage when both match.
 *
 * Whole words, not substrings: a substring table reads "docker" as docs and
 * "fixture" as bugfix, and this classifier is not cosmetic — it picks the cost
 * row that decides `wouldRefuse`, which is the evidence D3 says 2.1's
 * refuse-by-default decision will be argued from. Noise here becomes a wrong
 * answer to "how often would the refusal have been wrong?". Word forms are
 * therefore listed explicitly; an unlisted form falls through to a later row
 * or to "other", and guessing low is the conservative failure.
 */
const KEYWORDS: readonly (readonly [TaskKind, readonly string[]])[] = [
  [
    "bugfix",
    ["fix", "fixes", "fixed", "fixing", "bug", "bugs", "broken", "regression", "regressions",
     "crash", "crashes", "crashing", "error", "errors", "defect", "defects", "repair"],
  ],
  ["tests", ["test", "tests", "testing", "spec", "specs", "coverage", "vitest", "jest", "pytest"]],
  [
    "docs",
    ["doc", "docs", "document", "documents", "documentation", "docstring", "docstrings",
     "readme", "comment", "comments", "changelog"],
  ],
  [
    "refactor",
    ["refactor", "refactors", "refactoring", "rename", "renames", "renaming", "extract",
     "cleanup", "clean up", "restructure", "simplify", "migrate", "migration"],
  ],
  [
    "explore",
    ["explore", "investigate", "find", "search", "understand", "audit", "review", "analyze",
     "analyse", "analysis"],
  ],
  [
    "crud",
    ["add", "create", "implement", "implements", "implementing", "endpoint", "endpoints",
     "model", "models", "schema", "schemas", "crud", "build", "write"],
  ],
];

/** Whole-word matcher for one row; `clean up` shows why a plain split() is not enough. */
const MATCHERS: readonly (readonly [TaskKind, RegExp])[] = KEYWORDS.map(([kind, words]) => [
  kind,
  new RegExp(`\\b(?:${words.map(escapeRegExp).join("|")})\\b`, "i"),
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic keyword classifier — no model call, so preflight stays free,
 * instant and reproducible. The prompt itself is never persisted here (C3);
 * only the resulting kind reaches `cost-samples.jsonl`.
 */
export function classifyTask(prompt: string): TaskKind {
  for (const [kind, matcher] of MATCHERS) {
    if (matcher.test(prompt)) {
      return kind;
    }
  }
  return "other";
}

export interface CostSample {
  readonly ts: string;
  readonly taskKind: TaskKind;
  readonly model: string;
  /** Directory basename of the repo, never a full path (C3). */
  readonly repo: string;
  readonly credits: number;
  readonly turns: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  // Hedge H4 (specs/v2-architecture.md): v4's adaptive routing is built from
  // exactly these fields, and one missing here is missing forever — the
  // history it should have been recorded in will not exist.
  readonly provider: "zai.zcode";
  readonly role: "worker" | "reviewer";
  readonly validationOk: boolean | null;
  readonly retries: number;
  readonly costClass: "subscription";
}

/**
 * Appends one JSON line to cost-samples.jsonl. Never throws: cost history is
 * an optimization the next run can live without, and the run that earned the
 * sample has already done its work by the time this is called.
 */
export function recordSample(home: string, sample: CostSample): void {
  const file = costSamplesPath(home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(sample) + "\n", "utf8");
  } catch (error) {
    logger.debug(`estimator: could not record cost sample (${errorMessage(error)})`);
  }
}

/**
 * Reads the cost history. A missing file is "no history yet" and a malformed
 * line is skipped, not fatal — the same tolerate-the-wreckage contract as the
 * run store, because a truncated final line is normal crash wreckage.
 */
export function readSamples(home: string): CostSample[] {
  let text: string;
  try {
    text = fs.readFileSync(costSamplesPath(home), "utf8");
  } catch {
    return [];
  }
  const samples: CostSample[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isSampleLike(parsed)) {
        samples.push(parsed);
      } else {
        logger.debug(`estimator: line ${index + 1} in ${costSamplesPath(home)} is not a sample`);
      }
    } catch {
      logger.debug(`estimator: skipping malformed line ${index + 1} in ${costSamplesPath(home)}`);
    }
  }
  return samples;
}

/**
 * True only when the quota delta between two snapshots can be attributed to
 * exactly one run. All four rules must hold:
 *
 * - both snapshots have confidence "exact" or "cached" — an "unknown" side
 *   makes the delta fiction;
 * - fiveHour.resetAt is unchanged — a window reset mid-run makes the delta
 *   meaningless (used drops to 0 and the difference goes negative);
 * - the credit delta (end.used - start.used) is >= 0 — a negative delta
 *   means a reset or a server correction, not a cost;
 * - activeRunCount is exactly 1 — concurrent runs make credit attribution
 *   meaningless, so those runs record nothing rather than a wrong number.
 */
export function isCleanMeasurement(input: {
  startSnapshot: BudgetSnapshot;
  endSnapshot: BudgetSnapshot;
  activeRunCount: number;
}): boolean {
  const trusted = (confidence: BudgetSnapshot["confidence"]): boolean =>
    confidence === "exact" || confidence === "cached";
  return (
    trusted(input.startSnapshot.confidence) &&
    trusted(input.endSnapshot.confidence) &&
    input.startSnapshot.fiveHour.resetAt === input.endSnapshot.fiveHour.resetAt &&
    input.endSnapshot.fiveHour.used - input.startSnapshot.fiveHour.used >= 0 &&
    input.activeRunCount === 1
  );
}

export interface CostEstimate {
  readonly p50: number;
  readonly p90: number;
  readonly samples: number;
  readonly source: "history" | "baseline";
}

/**
 * Main-model baseline, p50/p90 in plan credits. Transcribed from doc §13 and
 * NEVER MEASURED on this stack — decision D3 keeps preflight refusal off in
 * 2.0.0 precisely because this table is unmeasured; a wrongly-high row would
 * refuse runs the quota could have afforded.
 */
const BASELINE_MAIN: Record<TaskKind, { readonly p50: number; readonly p90: number }> = {
  explore: { p50: 15, p90: 28 },
  crud: { p50: 42, p90: 66 },
  tests: { p50: 30, p90: 50 },
  docs: { p50: 12, p90: 22 },
  refactor: { p50: 45, p90: 75 },
  bugfix: { p50: 35, p90: 60 },
  other: { p50: 35, p90: 60 },
};

/** Fast models are assumed to cost 40% of the main row, rounded. */
const FAST_MODEL_RATIO = 0.4;

/** History starts winning at this many samples; below it the noise would outrank the baseline. */
const MIN_HISTORY_SAMPLES = 5;

/**
 * Estimated credits for one run of a task kind on a model. History wins when
 * at least MIN_HISTORY_SAMPLES samples match BOTH the task kind and the model;
 * otherwise the baseline table answers, with `samples: 0` and
 * `source: "baseline"`.
 *
 * Main vs fast is decided by comparing `model` with the `fastModel`
 * ARGUMENT — this module is deliberately config-free so it stays pure and
 * testable, and callers (preflight, part 2) pass config.models.fast in.
 */
export function estimateCost(
  home: string,
  taskKind: TaskKind,
  model: string,
  fastModel: string,
): CostEstimate {
  const credits = readSamples(home)
    .filter((entry) => entry.taskKind === taskKind && entry.model === model)
    .map((entry) => entry.credits);
  if (credits.length >= MIN_HISTORY_SAMPLES) {
    const sorted = [...credits].sort((a, b) => a - b);
    return {
      p50: nearestRank(sorted, 0.5),
      p90: nearestRank(sorted, 0.9),
      samples: sorted.length,
      source: "history",
    };
  }
  const main = BASELINE_MAIN[taskKind];
  if (model === fastModel) {
    return {
      p50: Math.round(main.p50 * FAST_MODEL_RATIO),
      p90: Math.round(main.p90 * FAST_MODEL_RATIO),
      samples: 0,
      source: "baseline",
    };
  }
  return { p50: main.p50, p90: main.p90, samples: 0, source: "baseline" };
}

/**
 * Nearest-rank percentile, deliberately NOT interpolation: sort ascending,
 * take index ceil(p * n) - 1, clamped into [0, n-1]. For p90 with n = 5 that
 * is literally the maximum sample. Interpolating would invent costs between
 * samples that never happened; the rank is the honest, conservative reading.
 * Do not "fix" this into interpolation later.
 */
function nearestRank(sortedAsc: readonly number[], p: number): number {
  const index = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[index];
}

/**
 * Same philosophy as the run store's isEventLike: "parses and has the fields
 * estimateCost reads" (taskKind, model, credits). A line that parses but
 * carries none of those cannot feed the estimator and is dropped; anything
 * richer is history written by a future version and is kept.
 */
function isSampleLike(value: unknown): value is CostSample {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.taskKind === "string" &&
    typeof candidate.model === "string" &&
    typeof candidate.credits === "number" &&
    Number.isFinite(candidate.credits)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
