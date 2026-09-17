import type { RouterConfig } from "./config.js";

/** Per-child-process timeout injected alongside the Z.ai env (spec §12). */
export const API_TIMEOUT_MS = "3000000";

/**
 * Environment injected into the claude.exe child process only (spec §12).
 * Never applied to the parent shell and never persisted globally.
 */
export function createGlmEnv(
  config: RouterConfig,
  zaiKey: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: zaiKey,
    ANTHROPIC_BASE_URL: config.provider.anthropicBaseUrl,
    API_TIMEOUT_MS,
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.models.main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.models.main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.models.fast,
    // GLM models are not in Claude Code's model catalog; without this it
    // enforces its assumed 200k context window on unknown models.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  };
}
