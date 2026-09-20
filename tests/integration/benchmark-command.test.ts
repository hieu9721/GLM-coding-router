import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkCommand, type BenchmarkDeps } from "../../src/commands/benchmark.js";
import { defaultConfig } from "../../src/core/config.js";
import { spawnAgentCapture } from "../../src/core/process.js";
import { WORKER_TOOLS } from "../../src/bin/glm-worker.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));
const NODE = process.execPath;

const RESULT_JSON = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1234,
  num_turns: 3,
  usage: { input_tokens: 900, output_tokens: 210 },
});

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-benchmark-cmd-");
  dirs.push(dir);
  return dir;
}

function makeHome(): string {
  const home = temp();
  const config = { ...defaultConfig(), claudePath: NODE };
  writeFileSyncAll(path.join(home, ".glm-coding-router", "config.json"), JSON.stringify(config));
  return home;
}

/** Default deps: injected key + config claudePath override; stdout captured by the caller. */
function baseDeps(overrides: Partial<BenchmarkDeps> = {}): BenchmarkDeps {
  return {
    home: makeHome(),
    env: { ZAI_API_KEY: "test-key", GLM_TEST_RESULT: RESULT_JSON } as NodeJS.ProcessEnv,
    readUserEnv: () => undefined,
    spawn: async () => ({ code: 0, stdout: RESULT_JSON, stderr: "" }),
    ...overrides,
  };
}

/** Spawn wrapper that routes the call to the real fake agent via spawnAgentCapture. */
function realCaptureSpawn(
  sideEffect?: (cwd: string) => void,
): NonNullable<BenchmarkDeps["spawn"]> {
  return async (binPath, options) => {
    void binPath;
    if (sideEffect) sideEffect(options.cwd);
    return spawnAgentCapture(NODE, { ...options, args: [FIXTURE] });
  };
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

function trackingMkdtemp(): { mkdtemp: () => string; created: string[] } {
  const created: string[] = [];
  const mkdtemp = () => {
    const dir = makeTempDir("glm-benchmark-run-");
    created.push(dir);
    return dir;
  };
  return { mkdtemp, created };
}

describe("benchmarkCommand happy paths (specs/benchmark.md)", () => {
  it("runs a task end to end through the real capture spawn, reports PASS and saves the report", async () => {
    const out = captureStdout();
    const { mkdtemp, created } = trackingMkdtemp();
    const implementation = 'function reverseWords(str) {\n  return String(str).trim().split(/\\s+/).filter(Boolean).reverse().join(" ");\n}\n\nmodule.exports = { reverseWords };\n';
    const deps = baseDeps({
      mkdtemp,
      spawn: realCaptureSpawn((cwd) => writeFileSyncAll(path.join(cwd, "src/util.js"), implementation)),
    });

    const code = await benchmarkCommand({ yes: true, task: ["fn-reverse"] }, deps);

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("fn-reverse");
    expect(text).toContain("PASS");
    expect(text).toContain("yes");
    expect(text).toContain("report saved to");
    expect(text).not.toContain("test-key");
    // Metrics from the parsed result document:
    expect(text).toContain("3"); // GLM calls
    expect(text).toContain("900/210"); // tokens i/o
    for (const dir of created) {
      expect(fs.existsSync(dir)).toBe(false); // run dirs cleaned up
    }
    const savedLine = text.split("\n").find((line) => line.startsWith("report saved to"));
    const savedPath = savedLine!.slice("report saved to ".length).trim();
    const saved = JSON.parse(readText(savedPath)) as { stack: string; tasks: { task: string; success: boolean }[] };
    expect(saved.stack).toBe("claude");
    expect(saved.tasks[0]).toMatchObject({ task: "fn-reverse", success: true });
  });

  it("reports FAIL with the validation tail when the worker solved nothing", async () => {
    const out = captureStdout();
    const deps = baseDeps({ spawn: realCaptureSpawn() }); // no side effect → test.js still fails

    const code = await benchmarkCommand({ yes: true, task: ["fn-reverse"] }, deps);

    expect(code).toBe(0); // failed task is a measurement, not a CLI error
    expect(out.text()).toContain("FAIL");
    expect(out.text()).toContain("validation output");
  });

  it("spawns with glm-worker args + --output-format json and the GLM env in the run dir", async () => {
    const calls: { args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const filesAtSpawn: boolean[] = [];
    const { mkdtemp, created } = trackingMkdtemp();
    const deps = baseDeps({
      mkdtemp,
      spawn: async (binPath, options) => {
        calls.push({ args: options.args, cwd: options.cwd, env: options.env });
        filesAtSpawn.push(
          fs.existsSync(path.join(options.cwd, "stats.js")),
          fs.existsSync(path.join(options.cwd, "test.js")),
        );
        return { code: 0, stdout: RESULT_JSON, stderr: "" };
      },
    });

    await benchmarkCommand({ yes: true, task: ["fix-bug"], maxTurns: 7 }, deps);

    expect(calls.length).toBe(1);
    expect(calls[0].args).toEqual([
      "-p",
      expect.stringContaining("median"),
      "--max-turns",
      "7",
      "--permission-mode",
      "acceptEdits",
      "--tools",
      WORKER_TOOLS,
      // A benchmark measures a fixed tool surface, so no inherited MCP servers
      // (specs/review-mcp-isolation.md).
      "--strict-mcp-config",
      "--output-format",
      "json",
    ]);
    expect(calls[0].cwd).toBe(created[0]);
    expect(calls[0].env.ANTHROPIC_AUTH_TOKEN).toBe("test-key");
    expect(calls[0].env.ANTHROPIC_API_KEY).toBe("");
    expect(calls[0].env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    // Task files were written into the run dir before the spawn:
    expect(filesAtSpawn).toEqual([true, true]);
  });

  it("repeat=2 runs each task twice and defaults to the config maxTurns", async () => {
    const spawnCalls: unknown[] = [];
    const deps = baseDeps({
      spawn: async () => {
        spawnCalls.push(1);
        return { code: 0, stdout: RESULT_JSON, stderr: "" };
      },
    });

    await benchmarkCommand({ yes: true, task: ["fn-reverse"], repeat: 2 }, deps);

    expect(spawnCalls.length).toBe(2);
  });

  it("--json emits a valid report object with savedPath and no key", async () => {
    const out = captureStdout();
    const deps = baseDeps();

    const code = await benchmarkCommand({ yes: true, task: ["fn-reverse"], json: true }, deps);

    expect(code).toBe(0);
    const text = out.text();
    expect(text).not.toContain("test-key");
    const report = JSON.parse(text) as { stack: string; savedPath: string; tasks: unknown[] };
    expect(report.stack).toBe("claude");
    expect(report.savedPath.endsWith(".json")).toBe(true);
    expect(report.tasks.length).toBe(1);
  });
});

describe("benchmarkCommand guards (specs/benchmark.md)", () => {
  it("non-interactive without --yes → ERROR [2]", async () => {
    await expect(benchmarkCommand({ task: ["fn-reverse"] }, baseDeps({ interactive: false }))).rejects.toMatchObject({
      codeName: "INVALID_ARGS",
      exitCode: 2,
    });
  });

  it("interactive confirm=false cancels without spawning", async () => {
    let spawned = 0;
    const deps = baseDeps({
      interactive: true,
      confirm: async () => false,
      spawn: async () => {
        spawned += 1;
        return { code: 0, stdout: RESULT_JSON, stderr: "" };
      },
    });
    const out = captureStdout();

    const code = await benchmarkCommand({ task: ["fn-reverse"] }, deps);

    expect(code).toBe(1);
    expect(out.text()).toContain("Cancelled.");
    expect(spawned).toBe(0);
  });

  it("dry-run spawns nothing and needs no key or claude", async () => {
    const out = captureStdout();
    const deps: BenchmarkDeps = {
      spawn: async () => {
        throw new Error("dry-run must not spawn");
      },
    };

    const code = await benchmarkCommand({ dryRun: true, task: ["fn-reverse"] }, deps);

    expect(code).toBe(0);
    expect(out.text()).toContain("would run tasks   fn-reverse");
    expect(out.text()).toContain("would run stack   claude");
  });

  it("unknown task, codex stack, and unknown stack all fail ERROR [2]", async () => {
    await expect(benchmarkCommand({ yes: true, task: ["nope"] }, baseDeps())).rejects.toMatchObject({
      codeName: "INVALID_ARGS",
    });
    await expect(benchmarkCommand({ yes: true, stack: "codex" }, baseDeps())).rejects.toMatchObject({
      codeName: "INVALID_ARGS",
      message: expect.stringContaining("codex"),
    });
    await expect(benchmarkCommand({ yes: true, stack: "vim" }, baseDeps())).rejects.toMatchObject({
      codeName: "INVALID_ARGS",
    });
  });

  it("bad --repeat / --max-turns values fail ERROR [2]", async () => {
    await expect(benchmarkCommand({ yes: true, repeat: 0 }, baseDeps())).rejects.toMatchObject({
      codeName: "INVALID_ARGS",
    });
    await expect(benchmarkCommand({ yes: true, maxTurns: 0 }, baseDeps())).rejects.toMatchObject({
      codeName: "INVALID_ARGS",
    });
  });

  it("missing key → ERROR [10]; missing claude → ERROR [20]", async () => {
    const home = temp(); // no config file → defaults, no claudePath override
    await expect(
      benchmarkCommand(
        { yes: true },
        { home, env: {} as NodeJS.ProcessEnv, readUserEnv: () => undefined },
      ),
    ).rejects.toMatchObject({ codeName: "ZAI_KEY_MISSING", exitCode: 10 });

    await expect(
      benchmarkCommand(
        { yes: true },
        { home, env: { ZAI_API_KEY: "k" } as NodeJS.ProcessEnv, readUserEnv: () => undefined },
      ),
    ).rejects.toMatchObject({ codeName: "CLAUDE_NOT_FOUND", exitCode: 20 });
  });

  it("worker crash exit is recorded as intervention needed; command still exits 0", async () => {
    const out = captureStdout();
    const deps = baseDeps({
      spawn: async () => ({ code: 3, stdout: "garbage", stderr: "boom" }),
    });

    const code = await benchmarkCommand({ yes: true, task: ["fn-reverse"] }, deps);

    expect(code).toBe(0);
    expect(out.text()).toContain("needed");
    expect(out.text()).toContain("no");
  });
});

describe("spawnAgentCapture (specs/benchmark.md)", () => {
  it("captures stdout, stderr, and the exit code from a real spawn", async () => {
    const outFile = path.join(temp(), "dump.json");
    const env = { GLM_TEST_RESULT: RESULT_JSON, GLM_TEST_EXIT: "5", GLM_TEST_OUTPUT: outFile };

    const result = await spawnAgentCapture(NODE, { args: [FIXTURE], cwd: path.dirname(FIXTURE), env, interactive: false });

    expect(result.code).toBe(5);
    expect(result.stdout).toContain('"num_turns":3');
    expect(JSON.parse(readText(outFile)) as unknown).toBeTruthy();
  });
});
