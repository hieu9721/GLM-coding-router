import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReview } from "../../src/bin/glm-review.js";
import { runWorker } from "../../src/bin/glm-worker.js";
import { defaultConfig } from "../../src/core/config.js";
import { runsDir } from "../../src/core/paths.js";
import type { CapturedResult, SpawnAgentOptions, SpawnStreamOptions } from "../../src/core/process.js";
import { callMcpTool, type McpDeps, type McpToolResult } from "../../src/mcp/server.js";
import { readEvents } from "../../src/runs/store.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

const BASIC_STREAM = fileURLToPath(new URL("../fixtures/streams/basic.ndjson", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));
const IS_WINDOWS = process.platform === "win32";

/**
 * Windows cannot actually exec the fake agent behind these surfaces:
 * fake-agent.mjs is not a PE image (spawn with shell:false refuses it), and
 * the argv pinned by buildWorkerArgs/buildReviewArgs cannot be reinterpreted
 * by node.exe (`node -p <prompt> --max-turns …` dies with "bad option"). The
 * real spawn is therefore emulated at the process seam using the fixture's
 * own GLM_TEST_STREAM / GLM_TEST_STDERR / GLM_TEST_EXIT contract — line-by-
 * line, exactly what fake-agent.mjs emits on a pipe. Everything downstream
 * (orchestration, registry, adapter, store, renderer, stdio contract) stays
 * real; the real streaming spawn itself is covered by worker-run.test.ts,
 * where argv is free-form.
 */
vi.mock("../../src/core/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/process.js")>();
  const fs = await import("node:fs");
  const lines = (file: string | undefined): string[] =>
    file && file.length > 0
      ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.length > 0)
      : [];
  return {
    ...actual,
    spawnAgentStream: async (_binPath: string, options: SpawnStreamOptions): Promise<{ code: number }> => {
      for (const line of lines(options.env.GLM_TEST_STREAM)) {
        options.onStdoutLine(line);
      }
      for (const line of lines(options.env.GLM_TEST_STDERR)) {
        options.onStderrLine(line);
      }
      return { code: Number(options.env.GLM_TEST_EXIT ?? 0) };
    },
    spawnAgent: async (_binPath: string, options: SpawnAgentOptions): Promise<number> =>
      Number(options.env.GLM_TEST_EXIT ?? 0),
  };
});

let dirs: string[] = [];
let savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv = {};
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
});

/** Temp home whose config points claudePath at the fake agent (spec §33 override). */
function homeWithFakeAgent(): string {
  const home = makeTempDir("glm-wiring-home-");
  dirs.push(home);
  writeFileSyncAll(
    path.join(home, ".glm-coding-router", "config.json"),
    JSON.stringify({ ...defaultConfig(), claudePath: FAKE_AGENT }),
  );
  return home;
}

/**
 * Point runWorker/runReview (which resolve home/config/key from the ambient
 * process) at a throwaway home: redirect os.homedir(), blank PATH so no real
 * claude is discovered ahead of the config override, and supply a key. The
 * child env still carries the usual process vars because only these keys change.
 */
function enterSandbox(overrides: NodeJS.ProcessEnv): string {
  const home = homeWithFakeAgent();
  for (const key of ["USERPROFILE", "HOME", "PATH", "ZAI_API_KEY", "GLM_TEST_STREAM", "GLM_TEST_EXIT", "GLM_ROUTER_OBSERVE"]) {
    savedEnv[key] = process.env[key];
  }
  if (IS_WINDOWS) {
    process.env.USERPROFILE = home;
  } else {
    process.env.HOME = home;
  }
  process.env.PATH = "";
  process.env.ZAI_API_KEY = "glm-wiring-test-key";
  delete process.env.GLM_TEST_STREAM;
  delete process.env.GLM_TEST_EXIT;
  delete process.env.GLM_ROUTER_OBSERVE;
  Object.assign(process.env, overrides);
  return home;
}

/**
 * resolvePrompt waits for stdin EOF before falling back to argv, and under
 * vitest stdin is a pipe that never sees one — keep nudging it with synthetic
 * EOF events while the binary call runs.
 */
async function withStdinEof<T>(run: () => Promise<T>): Promise<T> {
  if (process.stdin.isTTY) {
    return run();
  }
  const timer = setInterval(() => {
    try {
      process.stdin.emit("end");
    } catch {
      // Stream already finished — the next resolvePrompt call re-arms.
    }
  }, 5);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

/** Minimal child env for the MCP tests: key, no discoverable claude. */
function mcpEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ZAI_API_KEY: "glm-wiring-test-key", PATH: "", ...extra };
}

/** Every run directory left under the injected home, empty when nothing was observed. */
function runDirsUnder(home: string): string[] {
  const history = path.join(runsDir(home), "history");
  if (!fs.existsSync(history)) {
    return [];
  }
  const found: string[] = [];
  for (const date of fs.readdirSync(history)) {
    const dateDir = path.join(history, date);
    if (!fs.statSync(dateDir).isDirectory()) {
      continue;
    }
    for (const id of fs.readdirSync(dateDir)) {
      const runDir = path.join(dateDir, id);
      if (fs.statSync(runDir).isDirectory()) {
        found.push(runDir);
      }
    }
  }
  return found;
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
 * Spy on a REAL process stream: capture and swallow every write so the
 * assertion covers bytes that would have reached the OS, not an injected
 * stand-in (the C2 test explicitly requires the real ones).
 */
function spyProcessStream(stream: NodeJS.WriteStream): { restore(): void; read(): string; count(): number } {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, "write");
  spy.mockImplementation((chunk: Uint8Array | string) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return {
    restore: (): void => spy.mockRestore(),
    read: (): string => chunks.join(""),
    count: (): number => spy.mock.calls.length,
  };
}

describe("glm-worker / glm-review wiring (v2 spec Phase D part 3)", () => {
  it("runWorker observes: exits 0, a run dir exists under the injected home, stdout carries only the final text", async () => {
    const home = enterSandbox({ GLM_TEST_STREAM: BASIC_STREAM });
    const out = spyProcessStream(process.stdout);
    const err = spyProcessStream(process.stderr);
    try {
      const code = await withStdinEof(() => runWorker(["Summarize notes.txt"]));
      expect(code).toBe(0);
    } finally {
      out.restore();
      err.restore();
    }

    const found = runDirsUnder(home);
    expect(found).toHaveLength(1);
    expect(fs.existsSync(path.join(found[0], "events.jsonl"))).toBe(true);

    // C1 through the real CLI surface: stdout got exactly the final text —
    // no events, no progress markers, nothing else.
    expect(out.read()).toBe(withTrailingNewline(finalResultOf(BASIC_STREAM)));
  });

  it("runWorker with GLM_ROUTER_OBSERVE=off: no run dir at all, legacy path returns the child's exit code", async () => {
    const home = enterSandbox({ GLM_ROUTER_OBSERVE: "off", GLM_TEST_EXIT: "7" });
    const out = spyProcessStream(process.stdout);
    const err = spyProcessStream(process.stderr);
    let code: number;
    try {
      code = await withStdinEof(() => runWorker(["Summarize notes.txt"]));
    } finally {
      out.restore();
      err.restore();
    }

    expect(code).toBe(7);
    expect(runDirsUnder(home)).toEqual([]);
  });

  it("runReview observes: run recorded with kind 'review' and role 'reviewer' in the event envelope", async () => {
    const home = enterSandbox({ GLM_TEST_STREAM: BASIC_STREAM });
    const out = spyProcessStream(process.stdout);
    const err = spyProcessStream(process.stderr);
    try {
      const code = await withStdinEof(() => runReview(["Review the diff"]));
      expect(code).toBe(0);
    } finally {
      out.restore();
      err.restore();
    }

    const found = runDirsUnder(home);
    expect(found).toHaveLength(1);
    expect(readEvents(found[0])[0]).toMatchObject({ type: "RunStarted", kind: "review", role: "reviewer" });
  });
});

describe("MCP wiring (v2 spec Phase D part 3, contract C2)", () => {
  it("glm_worker observes: text equals the stream's final text, run dir exists, real stdout/stderr untouched", async () => {
    const home = homeWithFakeAgent();
    const cwd = makeTempDir("glm-wiring-cwd-");
    dirs.push(cwd);
    const deps: McpDeps = {
      home,
      cwd,
      env: mcpEnv({ GLM_TEST_STREAM: BASIC_STREAM }),
      readUserEnv: () => undefined,
    };
    const out = spyProcessStream(process.stdout);
    const err = spyProcessStream(process.stderr);
    let result: McpToolResult;
    try {
      result = await callMcpTool("glm_worker", { prompt: "Summarize notes.txt" }, deps);
    } finally {
      out.restore();
      err.restore();
    }

    expect(result.isError).toBe(false);
    expect(result.text).toBe(finalResultOf(BASIC_STREAM));
    expect(runDirsUnder(home)).toHaveLength(1);
    // Not a vacuous assertion: these are the real process streams (C2).
    expect(out.count()).toBe(0);
    expect(err.count()).toBe(0);
  });

  it("glm_worker with GLM_ROUTER_OBSERVE=off still works through the old capture path", async () => {
    const home = homeWithFakeAgent();
    const calls: { args: readonly string[] }[] = [];
    const deps: McpDeps = {
      home,
      env: mcpEnv({ GLM_ROUTER_OBSERVE: "off" }),
      readUserEnv: () => undefined,
      spawn: async (_binPath: string, options: SpawnAgentOptions): Promise<CapturedResult> => {
        calls.push({ args: options.args });
        return { code: 0, stdout: "WORKER_OUTPUT", stderr: "" };
      },
    };
    const result = await callMcpTool("glm_worker", { prompt: "task" }, deps);

    expect(result.isError).toBe(false);
    expect(result.text).toBe("WORKER_OUTPUT");
    expect(calls).toHaveLength(1);
    expect(runDirsUnder(home)).toEqual([]);
  });
});
