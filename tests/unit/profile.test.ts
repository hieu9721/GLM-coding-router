import { describe, expect, it } from "vitest";
import { applyProfile, extractProfileFlag } from "../../src/core/profile.js";
import { ConfigSchema, defaultConfig, type RouterConfig } from "../../src/core/config.js";
import { GlmRouterError } from "../../src/core/errors.js";

function configWithProfiles(profiles: NonNullable<RouterConfig["profiles"]>): RouterConfig {
  return { ...defaultConfig(), profiles };
}

describe("extractProfileFlag (specs/glm-fast-profiles.md)", () => {
  it("returns argv untouched when no flag is present", () => {
    expect(extractProfileFlag(["-p", "do work"])).toEqual({
      rest: ["-p", "do work"],
      profile: undefined,
    });
  });

  it("separates '--profile name' and keeps the rest in order", () => {
    expect(extractProfileFlag(["fix", "--profile", "test", "the", "bug"])).toEqual({
      rest: ["fix", "the", "bug"],
      profile: "test",
    });
  });

  it("accepts the '--profile=name' form", () => {
    expect(extractProfileFlag(["--profile=frontend", "ship it"])).toEqual({
      rest: ["ship it"],
      profile: "frontend",
    });
  });

  it("first occurrence wins and later ones are consumed, not forwarded", () => {
    expect(extractProfileFlag(["--profile", "a", "--profile=b"])).toEqual({
      rest: [],
      profile: "a",
    });
  });

  it("errors on a missing value (both forms)", () => {
    expect(() => extractProfileFlag(["--profile"])).toThrow(GlmRouterError);
    expect(() => extractProfileFlag(["--profile="])).toThrow(GlmRouterError);
  });
});

describe("applyProfile (specs/glm-fast-profiles.md)", () => {
  it("is a no-op without a profile name", () => {
    const config = defaultConfig();
    expect(applyProfile(config, undefined)).toBe(config);
  });

  it("overlays models and both maxTurns values", () => {
    const config = configWithProfiles({
      test: { main: "glm-4.7", fast: "glm-4.7-air", workerMaxTurns: 5, reviewMaxTurns: 9 },
    });
    const applied = applyProfile(config, "test");
    expect(applied.models).toEqual({ main: "glm-4.7", fast: "glm-4.7-air" });
    expect(applied.worker.maxTurns).toBe(5);
    expect(applied.review.maxTurns).toBe(9);
  });

  it("keeps unset fields from the base config", () => {
    const base = defaultConfig();
    const applied = applyProfile(configWithProfiles({ light: { workerMaxTurns: 3 } }), "light");
    expect(applied.models).toEqual(base.models);
    expect(applied.review.maxTurns).toBe(base.review.maxTurns);
    expect(applied.worker.maxTurns).toBe(3);
  });

  it("fails with ERROR [11] naming available profiles when unknown", () => {
    const config = configWithProfiles({ test: {}, backend: {} });
    expect(() => applyProfile(config, "nope")).toThrowError(
      /unknown profile "nope" — available profiles: backend, test/,
    );
    try {
      applyProfile(configWithProfiles({ test: {} }), "nope");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GlmRouterError);
      expect((error as GlmRouterError).exitCode).toBe(11);
    }
  });

  it("lists (none defined) when no profiles exist", () => {
    expect(() => applyProfile(defaultConfig(), "x")).toThrowError(/\(none defined\)/);
  });
});

describe("config schema: profiles field (specs/glm-fast-profiles.md)", () => {
  it("defaults to an empty map when absent", () => {
    const parsed = ConfigSchema.parse({
      schemaVersion: 1,
      provider: { name: "zai", anthropicBaseUrl: "https://api.z.ai/api/anthropic" },
      models: { main: "glm-5.3", fast: "glm-5.3-flash" },
      integrations: { claude: true, codex: true, codexSkill: true },
    });
    expect(parsed.profiles).toEqual({});
  });

  it("accepts a map of partial profiles", () => {
    const parsed = ConfigSchema.parse({
      schemaVersion: 1,
      provider: { name: "zai", anthropicBaseUrl: "https://api.z.ai/api/anthropic" },
      models: { main: "glm-5.3", fast: "glm-5.3-flash" },
      profiles: { frontend: { main: "glm-4.7" }, test: { workerMaxTurns: 8 } },
    });
    expect(parsed.profiles.frontend?.main).toBe("glm-4.7");
    expect(parsed.profiles.test?.workerMaxTurns).toBe(8);
  });

  it("rejects invalid profile field types", () => {
    const result = ConfigSchema.safeParse({
      schemaVersion: 1,
      provider: { name: "zai", anthropicBaseUrl: "https://api.z.ai/api/anthropic" },
      models: { main: "glm-5.3", fast: "glm-5.3-flash" },
      profiles: { bad: { workerMaxTurns: 0 } },
    });
    expect(result.success).toBe(false);
  });
});
