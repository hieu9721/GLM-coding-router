import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { spawnAgent, spawnAgentCapture, spawnAgentStream } from "../../src/core/process.js";
import { makeTempDir, readText, removeTempDir } from "../helpers/tmp.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));
const STREAM_FILE = fileURLToPath(new URL("../fixtures/streams/basic.ndjson", import.meta.url));
const NODE = process.execPath;

/** What the fixture must emit: the file's non-empty lines, in order. */
const STREAM_LINES = readText(STREAM_FILE)
  .split(/\r?\n/)
  .filter((line) => line.length > 0);

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
});

function temp(): string {
  const dir = makeTempDir("glm-stream-test-");
  dirs.push(dir);
  return dir;
}

interface StreamOutcome {
  readonly code: number;
  readonly stdoutLines: string[];
  readonly stderrLines: string[];
}

/**
 * Run the fake agent through spawnAgentStream, collecting every delivered
 * line. `hooks.onStdoutLine` rides along after collection, so a test can throw
 * from it without losing the record of what was delivered.
 */
function runStream(
  env: NodeJS.ProcessEnv,
  hooks: {
    onStdoutLine?: (line: string) => void;
    onSpawn?: (child: ChildProcess) => void;
  } = {},
): Promise<StreamOutcome> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return spawnAgentStream(NODE, {
    args: [FIXTURE],
    cwd: temp(),
    env,
    onSpawn: hooks.onSpawn,
    onStdoutLine: (line) => {
      stdoutLines.push(line);
      hooks.onStdoutLine?.(line);
    },
    onStderrLine: (line) => stderrLines.push(line),
  }).then(({ code }) => ({ code, stdoutLines, stderrLines }));
}

describe("spawnAgentStream with fake agent (v2 spec Phase D)", () => {
  it("replays basic.ndjson as ordered stdout lines, each parseable JSON", async () => {
    const result = await runStream({ GLM_TEST_STREAM: STREAM_FILE });
    expect(result.code).toBe(0);
    expect(result.stderrLines).toEqual([]);
    expect(result.stdoutLines).toEqual(STREAM_LINES);
    for (const line of result.stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Order evidence from the stream itself: system/init first, result last.
    expect((JSON.parse(result.stdoutLines[0]) as { type?: string }).type).toBe("system");
    expect((JSON.parse(result.stdoutLines[result.stdoutLines.length - 1]) as { type?: string }).type).toBe("result");
  });

  it("replays identically when chunks cut lines mid-JSON (GLM_TEST_SPLIT=1)", async () => {
    const result = await runStream({ GLM_TEST_STREAM: STREAM_FILE, GLM_TEST_SPLIT: "1" });
    expect(result.code).toBe(0);
    expect(result.stderrLines).toEqual([]);
    expect(result.stdoutLines).toEqual(STREAM_LINES);
  });

  it("routes GLM_TEST_STDERR lines to the stderr callback only", async () => {
    const result = await runStream({ GLM_TEST_STDERR: "first diagnostic\nsecond diagnostic" });
    expect(result.code).toBe(0);
    expect(result.stderrLines).toEqual(["first diagnostic", "second diagnostic"]);
    expect(result.stdoutLines).toEqual([]);
  });

  it("delivers a trailing line without a newline before resolving", async () => {
    // GLM_TEST_RESULT is the fixture's one write with no trailing newline —
    // the shape a crashed agent's last stdout line has.
    const result = await runStream({ GLM_TEST_RESULT: "orphan tail, no newline" });
    expect(result.code).toBe(0);
    expect(result.stdoutLines).toEqual(["orphan tail, no newline"]);
  });

  it("delivers lines while the child is alive, not in one blob at exit", async () => {
    const arrivals: number[] = [];
    let child: ChildProcess | undefined;
    let firstLineWhileChildAlive = false;
    const result = await runStream(
      { GLM_TEST_STREAM: STREAM_FILE, GLM_TEST_STREAM_DELAY_MS: "20" },
      {
        onSpawn: (spawned) => {
          child = spawned;
        },
        onStdoutLine: () => {
          arrivals.push(Date.now());
          if (arrivals.length === 1) {
            firstLineWhileChildAlive = child !== undefined && child.exitCode === null;
          }
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdoutLines).toEqual(STREAM_LINES);
    // Buffering everything until exit would deliver line 1 only after the
    // child died, flipping both assertions below.
    expect(firstLineWhileChildAlive).toBe(true);
    expect(arrivals[arrivals.length - 1] - arrivals[0]).toBeGreaterThanOrEqual(100);
  });

  it("propagates the child exit code and still delivers the lines", async () => {
    const result = await runStream({ GLM_TEST_STREAM: STREAM_FILE, GLM_TEST_EXIT: "3" });
    expect(result.code).toBe(3);
    expect(result.stdoutLines).toEqual(STREAM_LINES);
  });

  it("survives a throwing callback and keeps delivering later lines", async () => {
    let deliveries = 0;
    let threwOnFirst = false;
    const result = await runStream(
      { GLM_TEST_STREAM: STREAM_FILE },
      {
        onStdoutLine: () => {
          deliveries += 1;
          if (deliveries === 1) {
            threwOnFirst = true;
            throw new Error("callback exploded");
          }
        },
      },
    );
    expect(threwOnFirst).toBe(true);
    expect(deliveries).toBe(STREAM_LINES.length);
    expect(result.code).toBe(0);
    expect(result.stdoutLines).toEqual(STREAM_LINES);
  });

  it("reports spawn failure as CHILD_AGENT_FAILED", async () => {
    const cwd = temp();
    await expect(
      spawnAgentStream(path.join(cwd, "does-not-exist.exe"), {
        args: [],
        cwd,
        env: {},
        onStdoutLine: () => {},
        onStderrLine: () => {},
      }),
    ).rejects.toThrow(/CHILD_AGENT_FAILED|failed/i);
  });
});

describe("spawnAgent / spawnAgentCapture unchanged (regression smoke)", () => {
  it("spawnAgent still resolves the raw exit code", async () => {
    const cwd = temp();
    const outFile = path.join(cwd, "dump.json");
    const code = await spawnAgent(NODE, {
      args: [FIXTURE],
      cwd,
      env: { GLM_TEST_OUTPUT: outFile, GLM_TEST_EXIT: "5" },
      interactive: false,
    });
    expect(code).toBe(5);
    expect((JSON.parse(readText(outFile)) as { argv?: string[] }).argv).toEqual([]);
  });

  it("spawnAgentCapture still buffers stdout until exit", async () => {
    const cwd = temp();
    const captured = await spawnAgentCapture(NODE, {
      args: [FIXTURE],
      cwd,
      env: { GLM_TEST_RESULT: "captured body" },
    });
    expect(captured.code).toBe(0);
    expect(captured.stdout).toBe("captured body");
  });
});
