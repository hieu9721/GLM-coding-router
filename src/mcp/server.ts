import os from "node:os";
import { buildWorkerArgs } from "../bin/glm-worker.js";
import { buildReviewArgs } from "../bin/glm-review.js";
import { loadConfig } from "../core/config.js";
import { locateClaude } from "../core/claude.js";
import { createGlmEnv } from "../core/env.js";
import { Errors, formatGlmError, GlmRouterError } from "../core/errors.js";
import { gitTopLevel, type RunGit } from "../core/git.js";
import { spawnAgentCapture, type CapturedResult, type SpawnAgentOptions } from "../core/process.js";
import { applyProfile } from "../core/profile.js";
import { version } from "../core/version.js";
import {
  createDelegateWorktree,
  delegateBranch,
  removeDelegateWorktree,
  rollbackDelegateBranch,
  validateDelegateName,
} from "../core/worktree.js";
import { resolveZaiApiKey } from "../core/zai-key.js";
import { aggregateLocalUsage, describeWindow, fetchZaiQuota } from "../commands/usage.js";

/**
 * glm-mcp (specs/v1-architecture.md): the router exposed as MCP tools over
 * stdio JSON-RPC 2.0. Handlers build on core primitives only — they never
 * touch process.stdout, which is the protocol channel.
 */
export interface McpToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface McpDeps {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readUserEnv?: (name: string) => string | undefined;
  readonly cwd?: string;
  readonly spawn?: (binPath: string, options: SpawnAgentOptions) => Promise<CapturedResult>;
  readonly fetchImpl?: typeof fetch;
  readonly runGit?: RunGit;
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const PROMPT_PROPERTY = { type: "string", description: "The task prompt for the GLM agent." };

export const MCP_TOOLS: readonly ToolDefinition[] = [
  {
    name: "glm_worker",
    description:
      "Run a GLM implementation worker (claude.exe + Z.ai env; tools Read,Glob,Grep,Edit,Write,Bash; acceptEdits). Returns the worker's output.",
    inputSchema: {
      type: "object",
      properties: { prompt: PROMPT_PROPERTY, profile: { type: "string", description: "Config profile overlay (optional)." } },
      required: ["prompt"],
    },
  },
  {
    name: "glm_review",
    description:
      "Run a read-only GLM review/exploration worker (tools Read,Glob,Grep only — cannot edit or run commands).",
    inputSchema: {
      type: "object",
      properties: { prompt: PROMPT_PROPERTY, profile: { type: "string", description: "Config profile overlay (optional)." } },
      required: ["prompt"],
    },
  },
  {
    name: "glm_delegate",
    description:
      "Run a GLM worker in an isolated git worktree (branch glm/delegate/<name> from HEAD). Worktree and branch are kept afterwards — nothing is committed or merged automatically.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Delegate slug, e.g. backend or tests." },
        prompt: PROMPT_PROPERTY,
      },
      required: ["name", "prompt"],
    },
  },
  {
    name: "glm_usage",
    description: "Usage snapshot: Z.ai Coding Plan credit windows (5h/weekly) and local benchmark totals.",
    inputSchema: { type: "object", properties: {} },
  },
];

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty string.`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function errorText(error: unknown): McpToolResult {
  if (error instanceof GlmRouterError) {
    return { text: formatGlmError(error), isError: true };
  }
  return { text: error instanceof Error ? error.message : String(error), isError: true };
}

function tail(text: string, max = 400): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

async function runAgent(prompt: string, profile: string | undefined, kind: "worker" | "review", deps: McpDeps): Promise<McpToolResult> {
  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const config = applyProfile(loadConfig(home), profile);
  const resolved = resolveZaiApiKey({ env, readUserEnv: deps.readUserEnv });
  if (!resolved) {
    throw Errors.zaiKeyMissing();
  }
  const claudePath = locateClaude(config, env);
  const args = kind === "worker" ? buildWorkerArgs(prompt, config) : buildReviewArgs(prompt, config);
  const spawn = deps.spawn ?? spawnAgentCapture;
  const captured = await spawn(claudePath, {
    args,
    cwd: deps.cwd ?? process.cwd(),
    env: createGlmEnv(config, resolved.key, env),
    interactive: false,
  });
  const text = captured.stdout.trim() || "(no output)";
  if (captured.code !== 0) {
    return { text: `${text}\n[worker exited ${captured.code}]${captured.stderr ? `\n${tail(captured.stderr.trim())}` : ""}`, isError: true };
  }
  return { text, isError: false };
}

async function delegate(name: string, prompt: string, deps: McpDeps): Promise<McpToolResult> {
  validateDelegateName(name);
  const cwd = deps.cwd ?? process.cwd();
  const repoRoot = await gitTopLevel(cwd, deps.runGit);
  if (!repoRoot) {
    return { text: `Not inside a git repository (cwd: ${cwd}) — glm_delegate needs a repo root.`, isError: true };
  }
  const worktree = await createDelegateWorktree(repoRoot, name, { runGit: deps.runGit });
  const branch = delegateBranch(name);
  const summary = (exitCode: number, output: string): McpToolResult => ({
    text: [
      output.trim() || "(no output)",
      "",
      `worker exited ${exitCode}`,
      `worktree kept: ${worktree}`,
      `branch kept:   ${branch}`,
      `next: inspect ${worktree}, then merge ${branch} (or discard with git worktree remove)`,
    ].join("\n"),
    isError: exitCode !== 0,
  });

  try {
    const result = await runAgent(prompt, undefined, "worker", { ...deps, cwd: worktree });
    return summary(result.isError ? 1 : 0, result.text);
  } catch (error) {
    // Worker never started — roll back the pristine worktree + branch (specs/delegate-worktrees.md).
    await removeDelegateWorktree(repoRoot, worktree, { runGit: deps.runGit });
    await rollbackDelegateBranch(repoRoot, branch, { runGit: deps.runGit });
    return errorText(error);
  }
}

async function usage(deps: McpDeps): Promise<McpToolResult> {
  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const resolved = resolveZaiApiKey({ env, readUserEnv: deps.readUserEnv });
  if (!resolved) {
    throw Errors.zaiKeyMissing();
  }
  const lines: string[] = [];
  let isError = false;
  try {
    const quota = await fetchZaiQuota(resolved.key, deps.fetchImpl ?? fetch);
    lines.push(`Z.ai Coding Plan${quota.level ? ` (level: ${quota.level})` : ""}`);
    for (const limit of quota.limits ?? []) {
      const resets = typeof limit.nextResetTime === "number" ? ` — resets ${new Date(limit.nextResetTime).toISOString()}` : "";
      lines.push(`  ${describeWindow(limit).padEnd(15)} ${String(limit.currentValue ?? "?")} / ${String(limit.usage ?? "?")} credits (${String(limit.percentage ?? "?")}%)${resets}`);
    }
  } catch (error) {
    isError = true;
    lines.push(`Z.ai Coding Plan: ✗ ${error instanceof Error ? error.message : String(error)}`);
  }
  const local = aggregateLocalUsage(home);
  lines.push("");
  lines.push(
    local.runs === 0
      ? "Local (benchmark reports): (none yet)"
      : `Local (benchmark reports): runs ${local.runs} · tokens ${local.tokensIn} in / ${local.tokensOut} out · last ${local.lastFinishedAt}`,
  );
  return { text: lines.join("\n"), isError };
}

/** Execute one MCP tool call. Tool-level failures return isError, never throw. */
export async function callMcpTool(name: string, args: Record<string, unknown>, deps: McpDeps = {}): Promise<McpToolResult> {
  try {
    switch (name) {
      case "glm_worker":
        return await runAgent(requiredString(args, "prompt"), optionalString(args, "profile"), "worker", deps);
      case "glm_review":
        return await runAgent(requiredString(args, "prompt"), optionalString(args, "profile"), "review", deps);
      case "glm_delegate":
        return await delegate(requiredString(args, "name"), requiredString(args, "prompt"), deps);
      case "glm_usage":
        return await usage(deps);
      default:
        return { text: `Unknown tool "${name}". Available: ${MCP_TOOLS.map((tool) => tool.name).join(", ")}.`, isError: true };
    }
  } catch (error) {
    return errorText(error);
  }
}

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

/**
 * One MCP server instance: `handleLine` takes a stdin line and resolves the
 * JSON-RPC response frame to write back, or null (nothing to send —
 * notifications, blank or malformed lines). Pure with respect to stdio.
 */
export function createMcpServer(deps: McpDeps = {}): { handleLine(line: string): Promise<string | null> } {
  return {
    async handleLine(line: string): Promise<string | null> {
      const trimmed = line.trim();
      if (trimmed.length === 0) return null;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        return null;
      }
      if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return null;
      const id = message.id;
      if (id === undefined || id === null) return null; // notification
      const params = (typeof message.params === "object" && message.params !== null ? message.params : {}) as Record<string, unknown>;

      let body: Record<string, unknown>;
      try {
        switch (message.method) {
          case "initialize":
            body = {
              result: {
                protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "glm-coding-router", version },
              },
            };
            break;
          case "ping":
            body = { result: {} };
            break;
          case "tools/list":
            body = { result: { tools: MCP_TOOLS } };
            break;
          case "tools/call": {
            const result = await callMcpTool(String(params.name ?? ""), (params.arguments ?? {}) as Record<string, unknown>, deps);
            body = { result: { content: [{ type: "text", text: result.text }], isError: result.isError } };
            break;
          }
          default:
            body = { error: { code: -32601, message: `Method not found: ${message.method}` } };
        }
      } catch (error) {
        body = { error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` } };
      }
      return JSON.stringify({ jsonrpc: "2.0", id, ...body });
    },
  };
}
