import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { BENCHMARK_TASKS, benchmarkTaskById } from "../../src/templates/benchmark-tasks.js";
import { parseClaudeResult } from "../../src/commands/benchmark.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

function runValidate(cwd: string): number {
  try {
    execFileSync("node", ["test.js"], { cwd, windowsHide: true, stdio: "ignore" });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

describe("built-in task suite (specs/benchmark.md)", () => {
  it("has unique ids, non-empty files/prompts, node-based validation", () => {
    const ids = BENCHMARK_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of BENCHMARK_TASKS) {
      expect(task.id.length, task.id).toBeGreaterThan(0);
      expect(task.prompt.length, task.id).toBeGreaterThan(0);
      expect(Object.keys(task.files).length, task.id).toBeGreaterThan(0);
      expect(task.validate[0], task.id).toBe("node");
    }
  });

  it("fn-reverse: initial state fails, correct implementation passes", () => {
    const task = benchmarkTaskById("fn-reverse")!;
    const dir = makeTempDir("glm-bench-task-1-");
    try {
      for (const [relative, content] of Object.entries(task.files)) {
        writeFileSyncAll(path.join(dir, relative), content);
      }
      expect(runValidate(dir)).not.toBe(0);

      writeFileSyncAll(
        path.join(dir, "src/util.js"),
        'function reverseWords(str) {\n  return String(str).trim().split(/\\s+/).filter(Boolean).reverse().join(" ");\n}\n\nmodule.exports = { reverseWords };\n',
      );
      expect(runValidate(dir)).toBe(0);
    } finally {
      removeTempDir(dir);
    }
  });

  it("fix-bug: initial state fails, corrected median passes", () => {
    const task = benchmarkTaskById("fix-bug")!;
    const dir = makeTempDir("glm-bench-task-2-");
    try {
      for (const [relative, content] of Object.entries(task.files)) {
        writeFileSyncAll(path.join(dir, relative), content);
      }
      expect(runValidate(dir)).not.toBe(0);

      const fixed = readText(path.join(dir, "stats.js")).replace(
        "  return sorted[mid]; // BUG: wrong for even-length lists",
        [
          "  if (sorted.length % 2 === 1) return sorted[mid];",
          "  return (sorted[mid - 1] + sorted[mid]) / 2;",
        ].join("\n"),
      );
      writeFileSyncAll(path.join(dir, "stats.js"), fixed);
      expect(runValidate(dir)).toBe(0);
    } finally {
      removeTempDir(dir);
    }
  });

  it("benchmarkTaskById finds and misses", () => {
    expect(benchmarkTaskById("fn-reverse")?.id).toBe("fn-reverse");
    expect(benchmarkTaskById("nope")).toBeUndefined();
  });
});

describe("parseClaudeResult (specs/benchmark.md)", () => {
  it("reads turns, tokens, subtype, and duration from a result document", () => {
    const stdout = [
      '[claude-code:unrecognized_model] {"model":"glm-5.3"}',
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 12345,
        num_turns: 4,
        usage: { input_tokens: 1200, output_tokens: 340 },
      }),
    ].join("\n");
    const parsed = parseClaudeResult(stdout);
    expect(parsed).toMatchObject({
      subtype: "success",
      isError: false,
      numTurns: 4,
      durationMs: 12345,
      usage: { input_tokens: 1200, output_tokens: 340 },
    });
  });

  it("returns null fields for garbage or minimal output", () => {
    expect(parseClaudeResult("not json at all")).toBeNull();
    expect(parseClaudeResult("")).toBeNull();
    const minimal = parseClaudeResult(JSON.stringify({ type: "result" }));
    expect(minimal).toMatchObject({ subtype: undefined, numTurns: undefined, usage: undefined });
  });
});
