import { describe, expect, it } from "vitest";
import { resolveZaiApiKey } from "../../src/core/zai-key.js";
import { createGlmEnv } from "../../src/core/env.js";
import { defaultConfig } from "../../src/core/config.js";
import { redact } from "../../src/core/logging.js";

describe("resolveZaiApiKey (spec §10: process env → per-user store → fail)", () => {
  it("prefers the process environment", () => {
    const resolved = resolveZaiApiKey({
      env: { ZAI_API_KEY: "key-from-process" },
      readUserEnv: () => "key-from-user-env",
    });
    expect(resolved).toEqual({ key: "key-from-process", source: "process-env" });
  });

  it("falls back to the per-user store (Orca stale env)", () => {
    const resolved = resolveZaiApiKey({
      env: {},
      readUserEnv: () => "key-from-user-env",
    });
    expect(resolved).toEqual({ key: "key-from-user-env", source: "user-store" });
  });

  it("fails when neither source has the key", () => {
    expect(resolveZaiApiKey({ env: {}, readUserEnv: () => undefined })).toBeUndefined();
  });

  it("ignores blank values", () => {
    expect(
      resolveZaiApiKey({ env: { ZAI_API_KEY: "   " }, readUserEnv: () => "" }),
    ).toBeUndefined();
  });
});

describe("createGlmEnv (spec §12)", () => {
  it("injects Z.ai routing vars and blanks ANTHROPIC_API_KEY", () => {
    const config = defaultConfig();
    const env = createGlmEnv(config, "secret-key", { PATH: "C:\\Windows" });
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("secret-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.API_TIMEOUT_MS).toBe("3000000");
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(config.models.main);
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(config.models.main);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(config.models.fast);
    expect(env.PATH).toBe("C:\\Windows");
  });

  it("never mutates the base environment object", () => {
    const base = { PATH: "x" } as NodeJS.ProcessEnv;
    createGlmEnv(defaultConfig(), "k", base);
    expect(Object.keys(base)).toEqual(["PATH"]);
  });

  it("takes model names and base URL from config, not hardcode", () => {
    const config = defaultConfig();
    config.models.main = "custom-main";
    config.models.fast = "custom-fast";
    config.provider.anthropicBaseUrl = "https://example.test/api/anthropic";
    const env = createGlmEnv(config, "k", {});
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("custom-main");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("custom-fast");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://example.test/api/anthropic");
  });
});

describe("redact (spec §37)", () => {
  it("replaces secrets with [REDACTED]", () => {
    expect(redact("token=abcdef123456", ["abcdef123456"])).toBe("token=[REDACTED]");
  });

  it("handles multiple occurrences and multiple secrets", () => {
    expect(redact("a-k1 b-k1 c-k2", ["k1", "k2"])).toBe("a-[REDACTED] b-[REDACTED] c-[REDACTED]");
  });

  it("ignores empty or missing values", () => {
    expect(redact("unchanged", ["", undefined])).toBe("unchanged");
  });
});
