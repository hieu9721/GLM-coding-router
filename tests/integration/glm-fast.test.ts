import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fastModelConfig } from "../../src/bin/glm-fast.js";
import { buildWorkerArgs, WORKER_TOOLS } from "../../src/bin/glm-worker.js";
import { buildReviewArgs, REVIEW_TOOLS } from "../../src/bin/glm-review.js";
import { applyProfile } from "../../src/core/profile.js";
import { createGlmEnv } from "../../src/core/env.js";
import { defaultConfig } from "../../src/core/config.js";
import { spawnAgent } from "../../src/core/process.js";
import { makeTempDir, readText, removeTempDir } from "../helpers/tmp.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));
const NODE = process.execPath;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
});

function temp(): string {
  const dir = makeTempDir("glm-fast-test-");
  dirs.push(dir);
  return dir;
}

interface AgentDump {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
}

describe("fastModelConfig (specs/glm-fast-profiles.md)", () => {
  it("pins every model slot to the fast model in the child env", () => {
    const config = fastModelConfig(defaultConfig());
    expect(config.models).toEqual({ main: "glm-5.3-flash", fast: "glm-5.3-flash" });
    const env = createGlmEnv(config, "test-key", {});
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3-flash");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.3-flash");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.3-flash");
  });

  it("lets a profile's fast model flow into every slot, overriding main", () => {
    const config = fastModelConfig(
      applyProfile(
        {
          ...defaultConfig(),
          profiles: { air: { main: "glm-5.3", fast: "glm-air-x" } },
        },
        "air",
      ),
    );
    const env = createGlmEnv(config, "test-key", {});
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-air-x");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-air-x");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-air-x");
  });

  it("keeps the pinned fast env through a real spawn (fake agent)", async () => {
    const cwd = temp();
    const outFile = path.join(cwd, "dump.json");
    const env = { ...createGlmEnv(fastModelConfig(defaultConfig()), "k", {}), GLM_TEST_OUTPUT: outFile };
    const code = await spawnAgent(NODE, { args: [FIXTURE], cwd, env, interactive: false });
    expect(code).toBe(0);
    const dump = JSON.parse(readText(outFile)) as AgentDump;
    expect(dump.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3-flash");
    expect(dump.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.3-flash");
    expect(dump.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.3-flash");
  });
});

describe("--profile wiring in arg builders (specs/glm-fast-profiles.md)", () => {
  it("glm-worker uses the profile's workerMaxTurns", () => {
    const config = applyProfile(
      { ...defaultConfig(), profiles: { test: { workerMaxTurns: 6 } } },
      "test",
    );
    expect(buildWorkerArgs("task", config).slice(0, 8)).toEqual([
      "-p",
      "task",
      "--max-turns",
      "6",
      "--permission-mode",
      "acceptEdits",
      "--tools",
      WORKER_TOOLS,
    ]);
    // A profile tunes turns and models, never the Bash allowlist.
    expect(config.worker.allowedBash).toEqual(defaultConfig().worker.allowedBash);
  });

  it("glm-review uses the profile's reviewMaxTurns", () => {
    const config = applyProfile(
      { ...defaultConfig(), profiles: { deep: { reviewMaxTurns: 40 } } },
      "deep",
    );
    expect(buildReviewArgs("task", config)).toEqual([
      "-p",
      "task",
      "--max-turns",
      "40",
      "--tools",
      REVIEW_TOOLS,
    ]);
  });
});
