#!/usr/bin/env node
import { STRICT_MCP_ARGS } from "../core/agent-args.js";
import { loadConfig, type RouterConfig } from "../core/config.js";
import { locateClaude } from "../core/claude.js";
import { createGlmEnv } from "../core/env.js";
import { Errors, formatGlmError, GlmRouterError } from "../core/errors.js";
import { isMainModule } from "../core/main-guard.js";
import { logger, redact } from "../core/logging.js";
import { applyProfile, extractProfileFlag } from "../core/profile.js";
import { readStdin, resolvePrompt } from "../core/prompt.js";
import { spawnAgent } from "../core/process.js";
import { resolveZaiApiKey } from "../core/zai-key.js";

/** Read-only review surface (spec §17) — no Edit, Write, or Bash. */
export const REVIEW_TOOLS = "Read,Glob,Grep";

/**
 * Build the child arguments (spec §17, specs/review-mcp-isolation.md).
 *
 * `--tools` alone does not make this read-only: it restricts the built-in set,
 * while MCP tools from the user's config are additive — with our own server
 * registered, a review could call `glm_worker` and write files. STRICT_MCP_ARGS
 * is what actually holds the guarantee.
 */
export function buildReviewArgs(prompt: string, config: RouterConfig): string[] {
  return [
    "-p",
    prompt,
    "--max-turns",
    String(config.review.maxTurns),
    "--tools",
    REVIEW_TOOLS,
    ...STRICT_MCP_ARGS,
  ];
}

/**
 * glm-review (spec §17): read-only worker for exploration, call-graph
 * discovery, duplicate detection, dependency inspection, and review.
 */
export async function runReview(argv: readonly string[]): Promise<number> {
  const { rest, profile } = extractProfileFlag(argv);
  const prompt = await resolvePrompt(rest, readStdin, "glm-review");
  const config = applyProfile(loadConfig(), profile);
  const resolved = resolveZaiApiKey();
  if (!resolved) {
    throw Errors.zaiKeyMissing();
  }
  const claudePath = locateClaude(config);

  const args = buildReviewArgs(prompt, config);
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
  runReview(process.argv.slice(2)).then(
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
