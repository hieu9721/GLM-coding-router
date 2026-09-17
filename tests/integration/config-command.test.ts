import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { configSetCommand, configShowCommand } from "../../src/commands/config.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-config-test-");
  dirs.push(dir);
  return dir;
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

describe("configShowCommand / configSetCommand (spec §28)", () => {
  it("shows default config as json when no config.json exists yet", () => {
    const home = temp();
    const out = captureStdout();

    const code = configShowCommand({ json: true }, { home });

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed.config.models.main).toBe("glm-5.3");
  });

  it("renders default config as human-readable text", () => {
    const home = temp();
    const out = captureStdout();

    const code = configShowCommand({}, { home });

    expect(code).toBe(0);
    expect(out.text()).toContain("Main model: glm-5.3");
  });

  it("persists models.main to config.json on disk", () => {
    const home = temp();

    const code = configSetCommand("models.main", "glm-5.3-flash", {}, { home });

    expect(code).toBe(0);
    const raw = fs.readFileSync(path.join(home, ".glm-coding-router", "config.json"), "utf8");
    expect(JSON.parse(raw).models.main).toBe("glm-5.3-flash");
  });
});
