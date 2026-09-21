import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config.js";
import { activeRunFile, runsDir } from "../../src/core/paths.js";
import { createStreamAdapter } from "../../src/events/claude-adapter.js";
import { readEvents } from "../../src/runs/store.js";
import { detectParent, runInstrumented, shouldObserve } from "../../src/runs/worker-run.js";
import type { WorkerRunOptions, WorkerRunResult } from "../../src/runs/worker-run.js";
import { makeTempDir, readText, removeTempDir } from "../helpers/tmp.js";

const BASIC_STREAM = fileURLToPath(new URL("../fixtures/streams/basic.ndjson", import.meta.url));
const EDIT_STREAM = fileURLToPath(new URL("../fixtures/streams/edit.ndjson", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));
/**
 * The argv the fake agent needs (`node fake-agent.mjs …`) followed by the v1
 * argument shape buildWorkerArgs produces; worker-run appends after these.
 */
function defaultArgs(): string[] {
  return [FAKE_AGENT, "-p", "implement the task", "--max-turns", "20"];
}

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
});

/**
 * A real Node writable that collects bytes instead of emitting them — the
 * injected stand-in for stdout (the C1 channel) and stderr (the progress
 * channel). `isTTY = false` keeps the renderer in nested mode, the orchestrator
 * case.
 */
class MemoryStream extends Writable {
  public isTTY = false;
  private readonly parts: string[] = [];

  public constructor() {
    super({
      write: (chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void => {
        this.parts.push(String(chunk));
        callback();
      },
    });
  }

  public text(): string {
    return this.parts.join("");
  }
}

interface RunOutcome {
  readonly result: WorkerRunResult;
  readonly stdout: MemoryStream;
  readonly stderr: MemoryStream;
  readonly home: string;
}

/** One instrumented run against the fake agent, in throwaway home/cwd dirs. */
async function run(overrides: Partial<WorkerRunOptions> = {}): Promise<RunOutcome> {
  const home = makeTempDir("glm-worker-run-home-");
  const cwd = makeTempDir("glm-worker-run-cwd-");
  dirs.push(home, cwd);
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const result = await runInstrumented({
    kind: "worker",
    prompt: "Summarize notes.txt",
    args: defaultArgs(),
    claudePath: process.execPath,
    config: defaultConfig(),
    secrets: [],
    cwd,
    env: { GLM_TEST_STREAM: BASIC_STREAM },
    home,
    stdout,
    stderr,
    ...overrides,
  });
  return { result, stdout, stderr, home };
}

/** The fixture's final answer: `result` from its last (result) line. */
function finalResultOf(streamFile: string): string {
  const lines = readText(streamFile)
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { type?: string; result?: string };
  expect(last.type).toBe("result");
  return last.result ?? "";
}

function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}

/**
 * The event types a pure adapter replay of the same fixture produces. The live
 * run must match this sequence exactly (minus RunStarted, which worker-run
 * emits itself, and minus Heartbeats, whose count depends on wall-clock
 * throttling by design).
 */
function adapterTypeSequence(streamFile: string): string[] {
  const adapter = createStreamAdapter("/home/user/project");
  const types: string[] = [];
  for (const line of readText(streamFile).split(/\r?\n/)) {
    if (line.length === 0) continue;
    for (const event of adapter.onStdoutLine(line)) {
      types.push(event.type);
    }
  }
  return types;
}

function collectFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

describe("runInstrumented (v2 spec Phase D, wiring A+B+C)", () => {
  it("replays basic.ndjson end to end: exact stdout, events + summary on disk, active file gone, exit 0", async () => {
    const { result, stdout, stderr, home } = await run();

    expect(result.code).toBe(0);
    expect(result.runId).toMatch(/^run_/);
    // C1: stdout is EXACTLY the final text — one write, nothing else around it.
    expect(stdout.text()).toBe(withTrailingNewline(finalResultOf(BASIC_STREAM)));

    expect(fs.existsSync(path.join(result.runDir, "events.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(result.runDir, "summary.json"))).toBe(true);

    const events = readEvents(result.runDir);
    expect(events[0]?.type).toBe("RunStarted");
    const types = events.filter((event) => event.type !== "Heartbeat").map((event) => event.type);
    expect(types).toEqual(["RunStarted", ...adapterTypeSequence(BASIC_STREAM).filter((t) => t !== "Heartbeat")]);
    // thinking_tokens proved liveness: at least one Heartbeat reached the store.
    expect(events.some((event) => event.type === "Heartbeat")).toBe(true);

    const summary = JSON.parse(readText(path.join(result.runDir, "summary.json"))) as Record<string, unknown>;
    expect(summary).toMatchObject({
      id: result.runId,
      state: "COMPLETED",
      turns: 2,
      filesChanged: [],
      denied: 0,
      retries: 0,
      validation: "none",
    });

    // The run graduated from the registry to history.
    expect(fs.existsSync(activeRunFile(home, result.runId))).toBe(false);

    // Progress rendered to the injected stderr, never to stdout.
    expect(stdout.text()).not.toContain("[GLM]");
    expect(stderr.text()).toContain("[GLM]");
  });

  it("edit.ndjson: summary reports 2 files changed, both denials, and the denied validation", async () => {
    const { result, stdout } = await run({ env: { GLM_TEST_STREAM: EDIT_STREAM } });

    expect(result.code).toBe(0);
    expect(stdout.text()).toBe(withTrailingNewline(finalResultOf(EDIT_STREAM)));

    const summary = JSON.parse(readText(path.join(result.runDir, "summary.json"))) as {
      turns: number;
      denied: number;
      validation: string;
      filesChanged: string[];
    };
    expect(summary.turns).toBe(5);
    expect(summary.denied).toBe(2);
    expect(summary.validation).toBe("denied");
    expect([...summary.filesChanged].sort()).toEqual([
      "/home/user/project/add.py",
      "/home/user/project/test_add.py",
    ]);
  });

  it("progress goes to stderr only: stdout carries no [GLM] marker (C1)", async () => {
    const { stdout, stderr } = await run({ env: { GLM_TEST_STREAM: BASIC_STREAM } });

    expect(stdout.text()).not.toContain("[GLM]");
    expect(stderr.text()).toContain("[GLM]");
    // The nested RunStarted line — a real rendered event, not a stray byte.
    expect(stderr.text()).toContain("started");
  });

  it("C3 end to end: no secret, no prompt body, no final text in any file under runs/", async () => {
    const planted = "GLM_SK_PLANTED_7b3d9f1a2c4e";
    const bodyMarker = "PROMPT_BODY_MARKER_51f0c2aa";
    // A distinctive slice of the fixture's final answer — proof that what went
    // to stdout exists nowhere in the persisted history.
    const resultMarker = "entire contents of the file";
    const { stdout, home, result } = await run({
      prompt: `rotate ${planted} now\n${bodyMarker}\nthird line`,
      secrets: [planted],
      env: { GLM_TEST_STREAM: BASIC_STREAM },
    });

    // The final text DID reach stdout (with the secret redaction irrelevant here).
    expect(stdout.text()).toContain(resultMarker);
    // The persisted title is the redacted first line, not the prompt.
    expect(readEvents(result.runDir)[0]).toMatchObject({ taskTitle: "rotate [REDACTED] now" });

    const files = collectFiles(runsDir(home));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readText(file);
      expect(text.includes(planted), `${planted} leaked into ${file}`).toBe(false);
      expect(text.includes(bodyMarker), `${bodyMarker} leaked into ${file}`).toBe(false);
      expect(text.includes(resultMarker), `final text leaked into ${file}`).toBe(false);
    }
  });

  it("a failing child (exit 2 on a truncated stream) maps to exit 40 and leaves a readable events.jsonl", async () => {
    const scratch = makeTempDir("glm-worker-run-trunc-");
    dirs.push(scratch);
    const truncated = path.join(scratch, "truncated.ndjson");
    const lines = readText(BASIC_STREAM)
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    // Cut before the result line: no final text, no RunCompleted.
    fs.writeFileSync(truncated, lines.slice(0, 20).join("\n") + "\n", "utf8");

    const { result, stdout } = await run({ env: { GLM_TEST_STREAM: truncated, GLM_TEST_EXIT: "2" } });

    expect(result.code).toBe(40); // v1's CHILD_AGENT_FAILED code
    expect(stdout.text()).toBe(""); // no result captured → nothing written

    const rawLines = readText(path.join(result.runDir, "events.jsonl"))
      .split(/\r?\n/)
      .filter((line) => line !== "");
    expect(rawLines.length).toBeGreaterThan(0);
    for (const line of rawLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(readEvents(result.runDir)[0]?.type).toBe("RunStarted");
  });

  it("an unwritable home still runs the child and prints its output", async () => {
    const scratch = makeTempDir("glm-worker-run-brokenhome-");
    dirs.push(scratch);
    const homeAsFile = path.join(scratch, "home-is-a-file");
    fs.writeFileSync(homeAsFile, "a plain file, not a directory", "utf8");

    const { result, stdout } = await run({ home: homeAsFile, env: { GLM_TEST_STREAM: BASIC_STREAM } });

    expect(result.code).toBe(0);
    expect(stdout.text()).toBe(withTrailingNewline(finalResultOf(BASIC_STREAM)));
    expect(result.runId).toMatch(/^run_/);
  });

  it("the spawn receives BOTH --output-format stream-json and --verbose appended to the caller's args", async () => {
    const calls: { args: string[] }[] = [];
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      num_turns: 1,
      duration_ms: 12,
      result: "V2_OK",
    });
    const { result, stdout } = await run({
      env: {},
      spawnImpl: async (_binPath, opts) => {
        calls.push({ args: opts.args });
        opts.onStdoutLine(resultLine);
        return { code: 0 };
      },
    });

    expect(calls).toHaveLength(1);
    const prefix = defaultArgs();
    const args = calls[0]?.args ?? [];
    expect(args.slice(0, prefix.length)).toEqual(prefix);
    // claude 2.1.278 rejects stream-json without --verbose (A0 evidence).
    expect(args.slice(prefix.length)).toEqual(["--output-format", "stream-json", "--verbose"]);
    // The synthetic stream also proves the 0-exit rule: child 0 AND RunCompleted.
    expect(result.code).toBe(0);
    expect(stdout.text()).toBe("V2_OK\n");
  });
});

describe("shouldObserve (contract C4 escape hatch)", () => {
  it("is false when the caller passed --output-format, false when GLM_ROUTER_OBSERVE=off, true otherwise", () => {
    expect(shouldObserve(["-p", "task", "--max-turns", "20"], {})).toBe(true);
    expect(shouldObserve(["-p", "task", "--output-format", "json", "--verbose"], {})).toBe(false);
    expect(shouldObserve(["-p", "task"], { GLM_ROUTER_OBSERVE: "off" })).toBe(false);
  });
});

describe("detectParent", () => {
  it("maps CLAUDECODE, codex markers and neither to claude / codex / shell", () => {
    expect(detectParent({ CLAUDECODE: "1" })).toBe("claude");
    // Claude wins when both markers are present (the nested-Claude case).
    expect(detectParent({ CLAUDECODE: "1", CODEX_SESSION: "s" })).toBe("claude");
    expect(detectParent({ CODEX_SESSION: "sess-1" })).toBe("codex");
    expect(detectParent({ EXTRA_FLAG: "powered by codex" })).toBe("codex");
    expect(detectParent({ HOME: "/home/u", PATH: "/usr/bin" })).toBe("shell");
  });
});
