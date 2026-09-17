#!/usr/bin/env node
import { loadConfig, type RouterConfig } from "../core/config.js";
import { locateClaude } from "../core/claude.js";
import { createGlmEnv } from "../core/env.js";
import { Errors, formatGlmError, GlmRouterError } from "../core/errors.js";
import { isMainModule } from "../core/main-guard.js";
import { logger, redact } from "../core/logging.js";
import { applyProfile, extractProfileFlag } from "../core/profile.js";
import { spawnAgent } from "../core/process.js";
import { resolveZaiApiKey } from "../core/zai-key.js";

/**
 * Effective config for glm-fast: every model slot pinned to the fast model
 * (specs/glm-fast-profiles.md). Applied AFTER the profile so a profile's
 * `fast` model flows into all slots; a profile's `main` is overridden by design.
 */
export function fastModelConfig(config: RouterConfig): RouterConfig {
  return { ...config, models: { main: config.models.fast, fast: config.models.fast } };
}

/**
 * glm-fast (spec §54, specs/glm-fast-profiles.md): interactive chat pinned to
 * the fast model. Pass-through args like glm-chat; supports --profile.
 */
export async function runFast(argv: readonly string[]): Promise<number> {
  const { rest, profile } = extractProfileFlag(argv);
  const config = fastModelConfig(applyProfile(loadConfig(), profile));
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
  runFast(process.argv.slice(2)).then(
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
