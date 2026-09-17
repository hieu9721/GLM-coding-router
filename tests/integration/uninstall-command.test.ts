import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uninstallCommand } from "../../src/commands/uninstall.js";
import { configDir } from "../../src/core/paths.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-uninstall-test-");
  dirs.push(dir);
  return dir;
}

describe("uninstallCommand (spec §44)", () => {
  it("with --yes, removes the global config directory and keeps the API key", async () => {
    const home = temp();
    fs.mkdirSync(configDir(home), { recursive: true });
    fs.writeFileSync(path.join(configDir(home), "config.json"), "{}");
    const deleteEnv = vi.fn();

    const code = await uninstallCommand({ yes: true }, { home, deleteEnv });

    expect(code).toBe(0);
    expect(fs.existsSync(configDir(home))).toBe(false);
    expect(deleteEnv).not.toHaveBeenCalled();
  });

  it("with --force, strips managed markers from the project's CLAUDE.md", async () => {
    const home = temp();
    const root = temp();
    const claudeMd = path.join(root, "CLAUDE.md");
    fs.writeFileSync(
      claudeMd,
      "above\n\n<!-- glm-coding-router:start -->\ntest content\n<!-- glm-coding-router:end -->\n\nbelow\n",
    );

    const code = await uninstallCommand({ force: true }, { home, root, deleteEnv: vi.fn() });

    expect(code).toBe(0);
    const content = fs.readFileSync(claudeMd, "utf8");
    expect(content).not.toContain("<!-- glm-coding-router:start -->");
    expect(content).not.toContain("<!-- glm-coding-router:end -->");
    expect(content).toContain("above");
    expect(content).toContain("below");
  });

  // The removeKey wizard branch reads process.stdin.isTTY of the test runner process, which must not be mutated.
});
