import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeRunFile,
  activeRunsDir,
  configDir,
  runDir,
  runHistoryDir,
  runsDir,
} from "../../src/core/paths.js";

// Every expectation builds the expected value with path.join too, so the
// suite asserts layout, not a separator, and passes on Windows and POSIX.
describe("run paths (specs/v2-architecture.md Phase B)", () => {
  const home = path.join("tmp", "glm-run-home");
  const runs = path.join(home, ".glm-coding-router", "runs");

  it("runsDir is <configDir>/runs", () => {
    expect(runsDir(home)).toBe(path.join(configDir(home), "runs"));
    expect(runsDir(home)).toBe(runs);
  });

  it("defaults home to os.homedir()", () => {
    expect(runsDir()).toBe(path.join(os.homedir(), ".glm-coding-router", "runs"));
  });

  it("activeRunsDir is <runs>/active", () => {
    expect(activeRunsDir(home)).toBe(path.join(runs, "active"));
  });

  it("runHistoryDir is <runs>/history/<date>", () => {
    expect(runHistoryDir(home, "2026-09-20")).toBe(path.join(runs, "history", "2026-09-20"));
  });

  it("runDir is <runs>/history/<date>/<id>", () => {
    expect(runDir(home, "2026-09-20", "run_01JZZ")).toBe(
      path.join(runs, "history", "2026-09-20", "run_01JZZ"),
    );
  });

  it("activeRunFile is <runs>/active/<id>.json", () => {
    const id = "run_01JZZ";
    const file = activeRunFile(home, id);
    expect(file).toBe(path.join(runs, "active", `${id}.json`));
    expect(file.endsWith(`${id}.json`)).toBe(true);
  });
});
