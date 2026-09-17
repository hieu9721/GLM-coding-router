import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig, loadConfig, saveConfig, setConfigValue } from "../../src/core/config.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";
import { GlmRouterError } from "../../src/core/errors.js";

let home = "";

afterEach(() => {
  if (home) {
    removeTempDir(home);
    home = "";
  }
});

function configFilePath(): string {
  return path.join(home, ".glm-coding-router", "config.json");
}

describe("loadConfig", () => {
  it("returns defaults when the file is missing", () => {
    home = makeTempDir();
    const config = loadConfig(home);
    expect(config).toEqual(defaultConfig());
    expect(config.models.main).toBe("glm-5.3");
    expect(config.models.fast).toBe("glm-5.3-flash");
  });

  it("loads a valid config", () => {
    home = makeTempDir();
    writeFileSyncAll(
      configFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        provider: { name: "zai", anthropicBaseUrl: "https://api.z.ai/api/anthropic" },
        models: { main: "glm-5.3", fast: "glm-5.3-flash" },
        worker: { maxTurns: 30 },
        review: { maxTurns: 10 },
      }),
    );
    const config = loadConfig(home);
    expect(config.worker.maxTurns).toBe(30);
    expect(config.integrations.claude).toBe(true);
  });

  it("fails with exit code 11 on invalid JSON", () => {
    home = makeTempDir();
    writeFileSyncAll(configFilePath(), "{ not json");
    try {
      loadConfig(home);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GlmRouterError);
      expect((error as GlmRouterError).exitCode).toBe(11);
    }
  });

  it("fails on schema violations (bad model, bad url)", () => {
    home = makeTempDir();
    writeFileSyncAll(
      configFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        provider: { name: "zai", anthropicBaseUrl: "not-a-url" },
        models: { main: "", fast: "glm-5.3-flash" },
        worker: { maxTurns: 20 },
        review: { maxTurns: 15 },
      }),
    );
    expect(() => loadConfig(home)).toThrow(GlmRouterError);
  });
});

describe("saveConfig", () => {
  it("round-trips through loadConfig", () => {
    home = makeTempDir();
    const config = defaultConfig();
    config.models.main = "glm-test-model";
    saveConfig(config, home);
    expect(readText(configFilePath())).toContain("glm-test-model");
    expect(loadConfig(home).models.main).toBe("glm-test-model");
    // No stray tmp files left behind
    const files = fs.readdirSync(path.dirname(configFilePath()));
    expect(files).toEqual(["config.json"]);
  });
});

describe("setConfigValue (spec §28)", () => {
  it("sets a string value", () => {
    const updated = setConfigValue(defaultConfig(), "models.main", "glm-5.3");
    expect(updated.models.main).toBe("glm-5.3");
  });

  it("coerces numbers for numeric keys", () => {
    const updated = setConfigValue(defaultConfig(), "worker.maxTurns", "35");
    expect(updated.worker.maxTurns).toBe(35);
  });

  it("coerces booleans for integration flags", () => {
    const updated = setConfigValue(defaultConfig(), "integrations.codexSkill", "false");
    expect(updated.integrations.codexSkill).toBe(false);
  });

  it("rejects non-numeric input for numeric keys", () => {
    expect(() => setConfigValue(defaultConfig(), "worker.maxTurns", "many")).toThrow(GlmRouterError);
  });

  it("rejects unknown keys", () => {
    expect(() => setConfigValue(defaultConfig(), "models.nonexistent", "x")).toThrow(GlmRouterError);
  });

  it("rejects values that fail schema validation", () => {
    expect(() => setConfigValue(defaultConfig(), "worker.maxTurns", "-5")).toThrow(GlmRouterError);
  });
});
