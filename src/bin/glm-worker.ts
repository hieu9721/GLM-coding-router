#!/usr/bin/env node
import { STRICT_MCP_ARGS } from "../core/agent-args.js";
import { loadConfig, type RouterConfig } from "../core/config.js";
import { locateClaude } from "../core/claude.js";
import { createGlmEnv } from "../core/env.js";
import { Errors, formatGlmError, GlmRouterError } from "../core/errors.js";
import { isMainModule } from "../core/main-guard.js";
import { logger, redact } from "../core/logging.js";
import { applyProfile, extractProfileFlag } from "../core/profile.js";
import { extractRoutingFlags } from "../core/routing-flags.js";
import { resolvePrompt } from "../core/prompt.js";
import { spawnAgent } from "../core/process.js";
import { resolveZaiApiKey } from "../core/zai-key.js";
import { runInstrumented, shouldObserve } from "../runs/worker-run.js";

/** Worker tool surface (spec §16). */
export const WORKER_TOOLS = "Read,Glob,Grep,Edit,Write,Bash";

/** Same surface minus Bash, used when no Bash command is allowed. */
export const WORKER_TOOLS_NO_BASH = "Read,Glob,Grep,Edit,Write";

/**
 * Build the child arguments (spec §16, specs/worker-bash-permissions.md).
 *
 * `--permission-mode acceptEdits` auto-approves file edits but NOT shell
 * commands, and headless `-p` has no prompt to answer — so without an explicit
 * `--allowedTools` every Bash call comes back "This command requires
 * approval". When the allowlist is empty we drop Bash from `--tools` entirely
 * rather than advertising a tool the worker can never use.
 *
 * STRICT_MCP_ARGS keeps the user's MCP servers out of the child
 * (specs/review-mcp-isolation.md): write is expected here, undeclared
 * recursion into `glm_delegate` and its own turn budget is not.
 */
export function buildWorkerArgs(prompt: string, config: RouterConfig): string[] {
  const allowedBash = config.worker.allowedBash;
  const args = [
    "-p",
    prompt,
    "--max-turns",
    String(config.worker.maxTurns),
    "--permission-mode",
    "acceptEdits",
    "--tools",
    allowedBash.length > 0 ? WORKER_TOOLS : WORKER_TOOLS_NO_BASH,
    // Before --allowedTools: its values are variadic and must stay last.
    ...STRICT_MCP_ARGS,
  ];
  if (allowedBash.length > 0) {
    args.push("--allowedTools", ...allowedBash.map((pattern) => `Bash(${pattern})`));
  }
  return args;
}

/** Strip `--no-bash`, which empties the allowlist for one invocation. */
export function extractNoBashFlag(argv: readonly string[]): {
  rest: string[];
  noBash: boolean;
} {
  const rest: string[] = [];
  let noBash = false;
  for (const arg of argv) {
    if (arg === "--no-bash") {
      noBash = true;
      continue;
    }
    rest.push(arg);
  }
  return { rest, noBash };
}

/**
 * glm-worker (spec §15, §16): headless implementation worker.
 * Prompt priority: arguments → stdin → error. Never uses
 * --dangerously-skip-permissions.
 */
export async function runWorker(argv: readonly string[]): Promise<number> {
  const { rest: withoutProfile, profile } = extractProfileFlag(argv);
  const { rest: withoutBashFlag, noBash } = extractNoBashFlag(withoutProfile);
  // Phase E flags come off last, and before resolvePrompt: everything still in
  // `rest` at that point becomes the prompt.
  const { rest, model, force, refreshQuota } = extractRoutingFlags(withoutBashFlag);
  const prompt = await resolvePrompt(rest);
  const loaded = applyProfile(loadConfig(), profile);
  const config: RouterConfig = noBash
    ? { ...loaded, worker: { ...loaded.worker, allowedBash: [] } }
    : loaded;
  const resolved = resolveZaiApiKey();
  if (!resolved) {
    throw Errors.zaiKeyMissing();
  }
  const claudePath = locateClaude(config);

  const args = buildWorkerArgs(prompt, config);
  const env = createGlmEnv(config, resolved.key);
  logger.debug(redact(`spawning ${claudePath} ${args.join(" ")}`, [resolved.key]));

  // v2 spec Phase D (C4): observe unless the caller opted out or already asked
  // for a specific --output-format. The legacy path stays byte-identical.
  if (!shouldObserve(args, process.env)) {
    return spawnAgent(claudePath, {
      args,
      cwd: process.cwd(),
      env,
      interactive: false,
    });
  }
  const observed = await runInstrumented({
    kind: "worker",
    prompt,
    args,
    claudePath,
    config,
    secrets: [resolved.key],
    cwd: process.cwd(),
    env,
    // Phase E. The legacy path above never reaches here, so these flags apply
    // to instrumented runs only — routing needs the event stream it observes.
    zaiKey: resolved.key,
    requestedModel: model,
    force,
    refreshQuota,
  });
  return observed.code;
}

if (isMainModule(import.meta.url)) {
  runWorker(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      if (error instanceof GlmRouterError) {
        process.stderr.write(formatGlmError(error) + "\n");
        process.exit(error.exitCode);
      }
      process.stderr.write(String(error) + "\n");
      process.exit(1);
    },
  );
}
