import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { callMcpTool, createMcpServer, MCP_TOOLS, type McpDeps } from "../../src/mcp/server.js";
import { defaultConfig } from "../../src/core/config.js";
import type { CapturedResult, SpawnAgentOptions } from "../../src/core/process.js";
import { WORKER_TOOLS } from "../../src/bin/glm-worker.js";
import { REVIEW_TOOLS } from "../../src/bin/glm-review.js";
import { makeTempDir, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

const NODE = process.execPath;

interface SpawnCall {
  readonly binPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

type TestSpawn = (binPath: string, options: SpawnAgentOptions) => Promise<CapturedResult>;

function homeWithClaude(): string {
  const home = makeTempDir("glm-mcp-home-");
  writeFileSyncAll(
    path.join(home, ".glm-coding-router", "config.json"),
    JSON.stringify({ ...defaultConfig(), claudePath: NODE }),
  );
  return home;
}

function makeDeps(spawnImpl?: (call: SpawnCall) => CapturedResult): { calls: SpawnCall[]; deps: McpDeps } {
  const calls: SpawnCall[] = [];
  const spawn: TestSpawn = async (binPath, options) => {
    const call = { binPath, args: options.args, cwd: options.cwd, env: options.env };
    calls.push(call);
    return spawnImpl ? spawnImpl(call) : { code: 0, stdout: "WORKER_OUTPUT", stderr: "" };
  };
  return {
    calls,
    deps: {
      home: homeWithClaude(),
      env: { ZAI_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      readUserEnv: () => undefined,
      spawn,
    },
  };
}

describe("MCP protocol (specs/v1-architecture.md)", () => {
  const server = createMcpServer({});

  it("initialize returns serverInfo and echoes the client's protocolVersion", async () => {
    const frame = await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-01-01", capabilities: {} } }),
    );
    const parsed = JSON.parse(frame!) as {
      result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: unknown } };
    };
    expect(parsed.result.protocolVersion).toBe("2025-01-01");
    expect(parsed.result.serverInfo.name).toBe("glm-coding-router");
    expect(parsed.result.capabilities.tools).toBeDefined();
  });

  it("notifications, blank lines, and malformed lines produce no frame", async () => {
    expect(await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    expect(await server.handleLine("")).toBeNull();
    expect(await server.handleLine("   ")).toBeNull();
    expect(await server.handleLine("not json")).toBeNull();
  });

  it("ping → {}; unknown methods → -32601; tools/list lists all four tools", async () => {
    const ping = JSON.parse((await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })))!) as { result: unknown };
    expect(ping.result).toEqual({});

    const unknown = JSON.parse(
      (await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list" })))!,
    ) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);

    const list = JSON.parse((await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" })))!) as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["glm_worker", "glm_review", "glm_delegate", "glm_usage"]);
    expect(MCP_TOOLS.length).toBe(4);
  });

  it("tools/call routes to the tool and wraps the result as a text content block", async () => {
    const { deps } = makeDeps();
    const s = createMcpServer(deps);
    const frame = await s.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "glm_worker", arguments: { prompt: "do it" } } }),
    );
    const parsed = JSON.parse(frame!) as { result: { content: { type: string; text: string }[]; isError: boolean } };
    expect(parsed.result.content[0].type).toBe("text");
    expect(parsed.result.content[0].text).toContain("WORKER_OUTPUT");
    expect(parsed.result.isError).toBe(false);
  });
});

describe("callMcpTool handlers (specs/v1-architecture.md)", () => {
  it("glm_worker spawns the worker surface with the GLM env and returns stdout", async () => {
    const { calls, deps } = makeDeps();
    const result = await callMcpTool("glm_worker", { prompt: "task" }, deps);
    expect(result.isError).toBe(false);
    expect(result.text).toBe("WORKER_OUTPUT");
    expect(calls[0].args).toEqual([
      "-p", "task", "--max-turns", "20", "--permission-mode", "acceptEdits", "--tools", WORKER_TOOLS,
    ]);
    expect(calls[0].env.ANTHROPIC_AUTH_TOKEN).toBe("test-key");
    expect(calls[0].env.ANTHROPIC_API_KEY).toBe("");
  });

  it("glm_review uses the read-only surface; non-zero exit → isError with stderr tail", async () => {
    const { calls, deps } = makeDeps((call) =>
      call.args.includes(REVIEW_TOOLS) ? { code: 7, stdout: "partial", stderr: "boom" } : { code: 0, stdout: "", stderr: "" },
    );
    const result = await callMcpTool("glm_review", { prompt: "look" }, deps);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("partial");
    expect(result.text).toContain("worker exited 7");
    expect(result.text).toContain("boom");
    expect(calls[0].args).toContain(REVIEW_TOOLS);
  });

  it("missing prompt / unknown tool → isError without throwing", async () => {
    const { deps } = makeDeps();
    const missing = await callMcpTool("glm_worker", {}, deps);
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("prompt");

    const unknown = await callMcpTool("glm_nothing", {}, deps);
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("glm_worker");
  });

  it("no key → ERROR [10] as tool error text", async () => {
    const home = makeTempDir("glm-mcp-nokey-");
    try {
      const result = await callMcpTool("glm_worker", { prompt: "x" }, {
        home,
        env: {} as NodeJS.ProcessEnv,
        readUserEnv: () => undefined,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("ERROR [ZAI_KEY_MISSING]");
    } finally {
      removeTempDir(home);
    }
  });

  it("glm_usage renders quota + local totals, and quota failure → isError with reason", async () => {
    const payload = {
      code: 200,
      data: {
        level: "lite",
        limits: [{ unit: 3, number: 5, usage: 2000, currentValue: 912, percentage: 45, nextResetTime: 1789715562684 }],
      },
    };
    const home = makeTempDir("glm-mcp-usage-");
    try {
      const ok = await callMcpTool("glm_usage", {}, {
        home,
        env: { ZAI_API_KEY: "k" } as NodeJS.ProcessEnv,
        readUserEnv: () => undefined,
        fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
      });
      expect(ok.isError).toBe(false);
      expect(ok.text).toContain("level: lite");
      expect(ok.text).toContain("912 / 2000 credits (45%)");
      expect(ok.text).toContain("(none yet");

      const failing = await callMcpTool("glm_usage", {}, {
        home,
        env: { ZAI_API_KEY: "k" } as NodeJS.ProcessEnv,
        readUserEnv: () => undefined,
        fetchImpl: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      });
      expect(failing.isError).toBe(true);
      expect(failing.text).toContain("unreachable");
    } finally {
      removeTempDir(home);
    }
  });

  it("glm_delegate runs the worker inside a created worktree and keeps worktree + branch", async () => {
    const repo = makeTempDir("glm-mcp-delegate-");
    const worktrees = path.join(path.dirname(path.resolve(repo)), `${path.basename(repo)}.glm-worktrees`);
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
      git(["init", "-b", "main"]);
      git(["config", "user.email", "t@t"]);
      git(["config", "user.name", "t"]);
      writeFileSyncAll(path.join(repo, "README.md"), "x\n");
      git(["add", "-A"]);
      git(["commit", "-m", "init"]);

      const { calls, deps } = makeDeps();
      const result = await callMcpTool("glm_delegate", { name: "backend", prompt: "implement" }, { ...deps, cwd: repo });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("branch kept:   glm/delegate/backend");
      expect(result.text).toContain("worktree kept:");
      expect(calls[0].cwd).toBe(path.join(worktrees, "backend"));
      expect(git(["branch", "--list", "glm/delegate/backend"])).toContain("glm/delegate/backend");
    } finally {
      removeTempDir(worktrees);
      removeTempDir(repo);
    }
  });

  it("glm_delegate outside a git repo → isError, no spawn", async () => {
    const dir = makeTempDir("glm-mcp-nogit-");
    try {
      const { calls, deps } = makeDeps();
      const result = await callMcpTool("glm_delegate", { name: "x", prompt: "y" }, { ...deps, cwd: dir });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("git repository");
      expect(calls.length).toBe(0);
    } finally {
      removeTempDir(dir);
    }
  });
});
