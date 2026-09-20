import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initCommand } from "../../src/commands/init.js";
import { ZAI_API_KEY_ENV } from "../../src/core/zai-key.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-init-test-");
  dirs.push(dir);
  return dir;
}

function isolatedEnv(pathDirs: string[]): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    PATHEXT: process.env.PATHEXT,
    PATH: pathDirs.join(path.delimiter),
  };
}

function configJson(home: string): string {
  return path.join(home, ".glm-coding-router", "config.json");
}

describe("initCommand (spec §7)", () => {
  it("with --yes and an entered key, stores the key and writes config.json", async () => {
    const home = temp();
    const emptyPath = temp();
    const setEnv = vi.fn();

    const code = await initCommand(
      { yes: true },
      {
        home,
        env: isolatedEnv([emptyPath]),
        readUserEnv: () => undefined,
        setEnv,
        // Exercise a machine that has a persistent store; the no-store path
        // is covered in key-command.test.ts (specs/cross-platform.md).
        store: "windows-user-env",
        prompt: async () => ({ key: "  test-key  " }),
      },
    );

    expect(code).toBe(0);
    const config = JSON.parse(fs.readFileSync(configJson(home), "utf8")) as {
      integrations: { claude: boolean };
    };
    expect(config.integrations.claude).toBe(true);
    expect(setEnv).toHaveBeenCalledTimes(1);
    expect(setEnv).toHaveBeenCalledWith(ZAI_API_KEY_ENV, "test-key");
  });

  it("exits 1 and writes nothing when the key prompt is cancelled", async () => {
    const home = temp();
    const emptyPath = temp();
    const setEnv = vi.fn();

    const code = await initCommand(
      { yes: true },
      {
        home,
        env: isolatedEnv([emptyPath]),
        readUserEnv: () => undefined,
        setEnv,
        // Exercise a machine that has a persistent store; the no-store path
        // is covered in key-command.test.ts (specs/cross-platform.md).
        store: "windows-user-env",
        prompt: async () => ({ key: undefined }),
      },
    );

    expect(code).toBe(1);
    expect(setEnv).not.toHaveBeenCalled();
    expect(fs.existsSync(configJson(home))).toBe(false);
  });

  // The "non-interactive terminal, no --yes" branch reads process.stdin.isTTY of the test runner process, which must not be mutated.
});
