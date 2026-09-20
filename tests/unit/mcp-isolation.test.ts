import { describe, expect, it } from "vitest";
import { buildReviewArgs, REVIEW_TOOLS } from "../../src/bin/glm-review.js";
import { buildWorkerArgs } from "../../src/bin/glm-worker.js";
import { STRICT_MCP_ARGS } from "../../src/core/agent-args.js";
import { defaultConfig } from "../../src/core/config.js";
import { callMcpTool, type McpDeps } from "../../src/mcp/server.js";
import type { CapturedResult, SpawnAgentOptions } from "../../src/core/process.js";
import { makeTempDir, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * specs/review-mcp-isolation.md — `--tools` only restricts the built-in set,
 * so without `--strict-mcp-config` a headless child inherits the user's MCP
 * servers. With our own server registered that gave `glm-review` a
 * write-capable `glm_worker`, defeating the read-only guarantee of spec §17.
 */
describe("MCP isolation on headless spawns (specs/review-mcp-isolation.md)", () => {
  const homes: string[] = [];
  afterAll(() => homes.forEach(removeTempDir));

  it("passes exactly one flag, and it is the documented one", () => {
    expect([...STRICT_MCP_ARGS]).toEqual(["--strict-mcp-config"]);
  });

  it("isolates the review child, which is what makes it read-only", () => {
    const args = buildReviewArgs("Review this", defaultConfig());
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe(REVIEW_TOOLS);
    // No --mcp-config: the strict set is empty, not a different set.
    expect(args).not.toContain("--mcp-config");
  });

  it("isolates the worker child, so it cannot recurse into glm_delegate", () => {
    const args = buildWorkerArgs("Do work", defaultConfig());
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });

  it("keeps the flag ahead of the variadic --allowedTools values", () => {
    const args = buildWorkerArgs("Do work", defaultConfig());
    expect(args.indexOf("--strict-mcp-config")).toBeLessThan(args.indexOf("--allowedTools"));
    // The Bash patterns must remain the tail of the array.
    expect(args[args.length - 1].startsWith("Bash(")).toBe(true);
  });

  it("isolates the worker child even when Bash is disabled", () => {
    const base = defaultConfig();
    const args = buildWorkerArgs("Do work", {
      ...base,
      worker: { ...base.worker, allowedBash: [] },
    });
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--allowedTools");
  });

  it.each(["glm_worker", "glm_review"] as const)(
    "isolates the MCP tool %s, the surface that creates the loop",
    async (tool) => {
      const home = makeTempDir("glm-isolation-home-");
      homes.push(home);
      writeFileSyncAll(
        path.join(home, ".glm-coding-router", "config.json"),
        JSON.stringify({ ...defaultConfig(), claudePath: process.execPath }),
      );
      let seen: readonly string[] = [];
      const deps: McpDeps = {
        home,
        env: { ZAI_API_KEY: "test-key" } as NodeJS.ProcessEnv,
        readUserEnv: () => undefined,
        spawn: (_binPath: string, options: SpawnAgentOptions): Promise<CapturedResult> => {
          seen = options.args;
          return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
        },
      };
      const result = await callMcpTool(tool, { prompt: "Task" }, deps);
      expect(result.isError).toBe(false);
      expect(seen).toContain("--strict-mcp-config");
    },
  );
});
