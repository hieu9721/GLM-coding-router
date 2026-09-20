import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { codexRequired, locateClaude, locateCodex, searchPathFor } from "../../src/core/claude.js";
import { GlmRouterError } from "../../src/core/errors.js";
import { makeTempDir, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";
import { exeName, onWindows } from "../helpers/platform.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
});

function temp(): string {
  const dir = makeTempDir("glm-discovery-test-");
  dirs.push(dir);
  return dir;
}

/** PATH fully replaced with `dirs` — isolates discovery from the real machine's PATH. */
function isolatedEnv(dirsToInclude: string[]): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    PATHEXT: process.env.PATHEXT,
    PATH: dirsToInclude.join(path.delimiter),
  };
}

describe("searchPathFor (spec §33)", () => {
  // The .exe/.cmd preference is Windows-only behavior by construction
  // (specs/cross-platform.md): off Windows the extension list is [""].
  it.runIf(onWindows)("prefers a native .exe over a .cmd shim in the same directory", () => {
    const dir = temp();
    writeFileSyncAll(path.join(dir, "claude.cmd"), "@echo off");
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const found = searchPathFor("claude", { PATH: dir });
    expect(found).toBe(path.join(dir, exeName("claude")));
  });

  it.runIf(onWindows)("falls back to the .cmd shim when no .exe exists (last resort)", () => {
    const dir = temp();
    writeFileSyncAll(path.join(dir, "claude.cmd"), "@echo off");
    const found = searchPathFor("claude", { PATH: dir });
    expect(found).toBe(path.join(dir, "claude.cmd"));
  });

  it.skipIf(onWindows)("finds the extensionless binary and ignores Windows spellings", () => {
    const dir = temp();
    writeFileSyncAll(path.join(dir, "claude.cmd"), "@echo off");
    writeFileSyncAll(path.join(dir, "claude.exe"), "");
    expect(searchPathFor("claude", { PATH: dir })).toBeUndefined();
    writeFileSyncAll(path.join(dir, "claude"), "#!/bin/sh");
    expect(searchPathFor("claude", { PATH: dir })).toBe(path.join(dir, "claude"));
  });

  it("returns undefined when nothing matches", () => {
    const dir = temp();
    expect(searchPathFor("claude", { PATH: dir })).toBeUndefined();
  });
});

describe("locateClaude (spec §33: where.exe -> PATH search -> config override -> error)", () => {
  it("finds claude via a PATH search when where.exe has nothing to find", () => {
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const found = locateClaude(undefined, isolatedEnv([dir]));
    expect(found).toBe(path.join(dir, exeName("claude")));
  });

  it("falls back to the config override when PATH search fails", () => {
    const empty = temp();
    const overrideDir = temp();
    const overridePath = path.join(overrideDir, "custom-claude.exe");
    writeFileSyncAll(overridePath, "");
    const found = locateClaude({ claudePath: overridePath } as never, isolatedEnv([empty]));
    expect(found).toBe(overridePath);
  });

  it("throws CLAUDE_NOT_FOUND with no override and nothing on PATH", () => {
    const empty = temp();
    try {
      locateClaude(undefined, isolatedEnv([empty]));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GlmRouterError);
      expect((error as GlmRouterError).codeName).toBe("CLAUDE_NOT_FOUND");
      expect((error as GlmRouterError).exitCode).toBe(20);
    }
  });

  it("throws CLAUDE_NOT_FOUND with a detail message when the override path doesn't exist", () => {
    const empty = temp();
    const missing = path.join(empty, "does-not-exist.exe");
    expect(() => locateClaude({ claudePath: missing } as never, isolatedEnv([empty]))).toThrow(
      /Configured claudePath override does not exist/,
    );
  });
});

describe("locateCodex (spec §34: absence is not fatal)", () => {
  it("finds codex via a PATH search", () => {
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("codex")), "");
    const found = locateCodex(undefined, isolatedEnv([dir]));
    expect(found).toBe(path.join(dir, exeName("codex")));
  });

  it("returns undefined (not throwing) when nothing is found and there is no override", () => {
    const empty = temp();
    expect(locateCodex(undefined, isolatedEnv([empty]))).toBeUndefined();
  });

  it("uses the config override when present and executable", () => {
    const empty = temp();
    const overrideDir = temp();
    const overridePath = path.join(overrideDir, "custom-codex.exe");
    writeFileSyncAll(overridePath, "");
    const found = locateCodex({ codexPath: overridePath } as never, isolatedEnv([empty]));
    expect(found).toBe(overridePath);
  });
});

describe("codexRequired (spec §34)", () => {
  it("throws CODEX_NOT_FOUND when codex is absent", () => {
    const empty = temp();
    try {
      codexRequired(undefined, isolatedEnv([empty]));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GlmRouterError);
      expect((error as GlmRouterError).codeName).toBe("CODEX_NOT_FOUND");
      expect((error as GlmRouterError).exitCode).toBe(21);
    }
  });

  it("returns the path when codex is present", () => {
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("codex")), "");
    expect(codexRequired(undefined, isolatedEnv([dir]))).toBe(path.join(dir, exeName("codex")));
  });
});
