/**
 * Built-in benchmark task suite (specs/benchmark.md, spec §54 v0.4).
 * Each task must be quota-small, objectively verifiable by a command
 * (no LLM judging), and representative (write code until a test passes).
 */
export interface BenchmarkTask {
  readonly id: string;
  readonly description: string;
  /** Files written into the throwaway run directory before the worker starts. */
  readonly files: Readonly<Record<string, string>>;
  /** The task prompt handed to the worker. */
  readonly prompt: string;
  /** Validation argv run in the run directory after the worker finishes. */
  readonly validate: readonly string[];
}

export const BENCHMARK_TASKS: readonly BenchmarkTask[] = [
  {
    id: "fn-reverse",
    description: "implement reverseWords from a stub until node test.js passes",
    files: {
      "src/util.js": [
        "// Implement reverseWords(str): reverse the ORDER of the words in str.",
        '// Example: reverseWords("hello world") === "world hello".',
        "// Collapse extra whitespace between words and trim the ends.",
        "function reverseWords(str) {",
        "  // TODO: implement",
        "}",
        "",
        "module.exports = { reverseWords };",
        "",
      ].join("\n"),
      "test.js": [
        'const assert = require("node:assert");',
        'const { reverseWords } = require("./src/util.js");',
        'assert.strictEqual(reverseWords("hello world"), "world hello");',
        'assert.strictEqual(reverseWords("a"), "a");',
        'assert.strictEqual(reverseWords("  spaced   out  "), "out spaced");',
        'assert.strictEqual(reverseWords(""), "");',
        'console.log("PASS");',
        "",
      ].join("\n"),
    },
    prompt: [
      "Implement reverseWords in src/util.js so that `node test.js` passes.",
      "Words are separated by whitespace; collapse repeats and trim the ends.",
      "Do not modify test.js. Verify by running `node test.js` with Bash.",
    ].join(" "),
    validate: ["node", "test.js"],
  },
  {
    id: "fix-bug",
    description: "repair an even-length median bug until node test.js passes",
    files: {
      "stats.js": [
        "// median(values) returns the median of a non-empty list of numbers.",
        "function median(values) {",
        "  const sorted = [...values].sort((a, b) => a - b);",
        "  const mid = Math.floor(sorted.length / 2);",
        "  return sorted[mid]; // BUG: wrong for even-length lists",
        "}",
        "",
        "module.exports = { median };",
        "",
      ].join("\n"),
      "test.js": [
        'const assert = require("node:assert");',
        'const { median } = require("./stats.js");',
        "assert.strictEqual(median([3, 1, 2]), 2);",
        "assert.strictEqual(median([4, 1, 3, 2]), 2.5);",
        "assert.strictEqual(median([5]), 5);",
        'console.log("PASS");',
        "",
      ].join("\n"),
    },
    prompt: [
      "stats.js has a bug: median() returns the wrong result for even-length lists.",
      "Fix it so that `node test.js` passes (even lists return the average of the two middle values).",
      "Do not modify test.js. Verify by running `node test.js` with Bash.",
    ].join(" "),
    validate: ["node", "test.js"],
  },
];

export function benchmarkTaskById(id: string): BenchmarkTask | undefined {
  return BENCHMARK_TASKS.find((task) => task.id === id);
}
