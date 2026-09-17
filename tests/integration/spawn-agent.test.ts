import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgent } from "../../src/core/process.js";
import { createGlmEnv } from "../../src/core/env.js";
import { defaultConfig } from "../../src/core/config.js";
import { makeTempDir, readText, removeTempDir } from "../helpers/tmp.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));
const NODE = process.execPath;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
});

function temp(): string {
  const dir = makeTempDir("glm-spawn-test-");
  dirs.push(dir);
  return dir;
}

interface AgentDump {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
}

function runFakeAgent(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; dump?: AgentDump }> {
  const outFile = path.join(cwd, "dump.json");
  const fullEnv = { ...env, GLM_TEST_OUTPUT: outFile };
  return spawnAgent(NODE, { args: [FIXTURE, ...args], cwd, env: fullEnv, interactive: false }).then(
    async (code) => {
      try {
        return { code, dump: JSON.parse(readText(outFile)) as AgentDump };
      } catch {
        return { code };
      }
    },
  );
}

describe("spawnAgent with fake agent (spec §18, §47)", () => {
  it("passes the argument array verbatim — no shell parsing (spec §39)", async () => {
    const cwd = temp();
    const result = await runFakeAgent(
      ["-p", "Fix login & logout `auth` \"quoted\" | pipe", "--tools", "Read,Glob,Grep"],
      {},
      cwd,
    );
    expect(result.code).toBe(0);
    expect(result.dump?.argv).toEqual([
      "-p",
      "Fix login & logout `auth` \"quoted\" | pipe",
      "--tools",
      "Read,Glob,Grep",
    ]);
  });

  it("propagates the child exit code", async () => {
    const cwd = temp();
    const result = await runFakeAgent([], { GLM_TEST_EXIT: "7" }, cwd);
    expect(result.code).toBe(7);
  });

  it("injects the GLM environment into the child only (spec §12)", async () => {
    const cwd = temp();
    const env = createGlmEnv(defaultConfig(), "test-zai-key", {});
    const result = await runFakeAgent([], env, cwd);
    expect(result.dump?.env.ANTHROPIC_API_KEY).toBe("");
    expect(result.dump?.env.ANTHROPIC_AUTH_TOKEN).toBe("test-zai-key");
    expect(result.dump?.env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(result.dump?.env.API_TIMEOUT_MS).toBe("3000000");
    // The parent (this test process) must NOT carry the injected vars.
    expect(process.env.ANTHROPIC_AUTH_TOKEN ?? "").not.toBe("test-zai-key");
  });

  it("inherits the working directory", async () => {
    const cwd = temp();
    const result = await runFakeAgent([], {}, cwd);
    expect(path.resolve(result.dump?.cwd ?? "")).toBe(path.resolve(cwd));
  });

  it("reports spawn failure as CHILD_AGENT_FAILED", async () => {
    const cwd = temp();
    await expect(
      spawnAgent(path.join(cwd, "does-not-exist.exe"), {
        args: [],
        cwd,
        env: {},
        interactive: false,
      }),
    ).rejects.toThrow(/CHILD_AGENT_FAILED|failed/i);
  });
});
