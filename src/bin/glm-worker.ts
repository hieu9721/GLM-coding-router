#!/usr/bin/env node
import { loadConfig, type RouterConfig } from "../core/config.js";
import { locateClaude } from "../core/claude.js";
import { createGlmEnv } from "../core/env.js";
import { Errors, formatGlmError, GlmRouterError } from "../core/errors.js";
import { isMainModule } from "../core/main-guard.js";
import { logger, redact } from "../core/logging.js";
import { resolvePrompt } from "../core/prompt.js";
import { spawnAgent } from "../core/process.js";
import { resolveZaiApiKey } from "../core/zai-key.js";

/** Worker tool surface (spec §16). */
export const WORKER_TOOLS = "Read,Glob,Grep,Edit,Write,Bash";

export function buildWorkerArgs(prompt: string, config: RouterConfig): string[] {
  return [
    "-p",
    prompt,
    "--max-turns",
    String(config.worker.maxTurns),
    "--permission-mode",
    "acceptEdits",
    "--tools",
    WORKER_TOOLS,
  ];
}

/**
 * glm-worker (spec §15, §16): headless implementation worker.
 * Prompt priority: stdin → arguments → error. Never uses
 * --dangerously-skip-permissions.
 */
export async function runWorker(argv: readonly string[]): Promise<number> {
  const prompt = await resolvePrompt(argv);
  const config = loadConfig();
  const resolved = resolveZaiApiKey();
  if (!resolved) {
    throw Errors.zaiKeyMissing();
  }
  const claudePath = locateClaude(config);

  const args = buildWorkerArgs(prompt, config);
  const env = createGlmEnv(config, resolved.key);
  logger.debug(redact(`spawning ${claudePath} ${args.join(" ")}`, [resolved.key]));

  return spawnAgent(claudePath, {
    args,
    cwd: process.cwd(),
    env,
    interactive: false,
  });
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
