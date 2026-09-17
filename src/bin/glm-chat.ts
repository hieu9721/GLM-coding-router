#!/usr/bin/env node
import { loadConfig } from "../core/config.js";
import { locateClaude } from "../core/claude.js";
import { createGlmEnv } from "../core/env.js";
import { Errors, formatGlmError, GlmRouterError } from "../core/errors.js";
import { isMainModule } from "../core/main-guard.js";
import { logger, redact } from "../core/logging.js";
import { applyProfile, extractProfileFlag } from "../core/profile.js";
import { spawnAgent } from "../core/process.js";
import { resolveZaiApiKey } from "../core/zai-key.js";

/**
 * glm-chat (spec §14): resolve key → detect claude.exe → inject Z.ai env →
 * spawn claude interactively with pass-through arguments.
 */
export async function runChat(argv: readonly string[]): Promise<number> {
  const { rest, profile } = extractProfileFlag(argv);
  const config = applyProfile(loadConfig(), profile);
  const resolved = resolveZaiApiKey();
  if (!resolved) {
    throw Errors.zaiKeyMissing();
  }
  const claudePath = locateClaude(config);

  const env = createGlmEnv(config, resolved.key);
  logger.debug(`spawning ${claudePath}`);
  logger.debug(redact(`env ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL}`, [resolved.key]));

  return spawnAgent(claudePath, {
    args: [...rest],
    cwd: process.cwd(),
    env,
    interactive: true,
  });
}

if (isMainModule(import.meta.url)) {
  runChat(process.argv.slice(2)).then(
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
