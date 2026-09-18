import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { loadConfig } from "../core/config.js";
import { locateClaude } from "../core/claude.js";
import { Errors } from "../core/errors.js";
import type { GlobalOptions } from "./context.js";

export const MCP_SERVER_NAME = "glm-coding-router";

/** Absolute path to the compiled glm-mcp entry next to this module. */
export function mcpServerScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // …/commands (dist or src)
  const compiled = path.resolve(here, "..", "bin", "glm-mcp.js");
  if (fs.existsSync(compiled)) {
    return compiled;
  }
  return path.resolve(here, "..", "bin", "glm-mcp.ts"); // dev checkout via tsx
}

export interface McpCommandDeps {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Runs the claude CLI; injectable for tests. */
  readonly runClaude?: (binPath: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function defaultRunClaude(binPath: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      binPath,
      args,
      { windowsHide: true, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException).code === "number" ? (error as unknown as { code: number }).code : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/**
 * glm-router mcp (specs/v1-architecture.md): opt-in registration of the
 * glm-mcp server. We never edit ~/.claude.json ourselves — install/remove go
 * through Claude Code's own `claude mcp add/remove` CLI.
 */
export async function mcpCommand(
  options: GlobalOptions,
  action: "info" | "install" | "remove" = "info",
  deps: McpCommandDeps = {},
): Promise<number> {
  const script = mcpServerScript();
  const node = process.execPath;

  if (action === "info") {
    const snippet = JSON.stringify(
      { mcpServers: { [MCP_SERVER_NAME]: { command: node, args: [script] } } },
      null,
      2,
    );
    process.stdout.write(
      [
        "Optional MCP server: glm-mcp exposes glm_worker, glm_review, glm_delegate, glm_usage as MCP tools.",
        "",
        "Register it with Claude Code:",
        "",
        `  claude mcp add -s user ${MCP_SERVER_NAME} -- "${node}" "${script}"`,
        "",
        "Or add this to your MCP client config:",
        "",
        snippet,
        "",
        "Remove again with:",
        "",
        `  claude mcp remove -s user ${MCP_SERVER_NAME}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const config = loadConfig(home);
  const claudePath = locateClaude(config, env); // ERROR [20] when missing
  const runClaude = deps.runClaude ?? defaultRunClaude;

  const args =
    action === "install"
      ? ["mcp", "add", "-s", "user", MCP_SERVER_NAME, "--", node, script]
      : ["mcp", "remove", "-s", "user", MCP_SERVER_NAME];

  const result = await runClaude(claudePath, args);
  if (result.code !== 0) {
    throw Errors.childAgentFailed(
      `claude mcp ${action} exited ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
    );
  }
  process.stdout.write(`✓ ${MCP_SERVER_NAME} MCP server ${action === "install" ? "registered" : "removed"} (claude -s user scope)\n`);
  if (result.stdout.trim() && !options.quiet) {
    process.stdout.write(`${result.stdout.trim()}\n`);
  }
  return 0;
}

