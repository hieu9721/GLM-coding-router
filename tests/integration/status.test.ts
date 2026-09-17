import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { statusCommand } from "../../src/commands/status.js";
import { makeTempDir, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-status-test-");
  dirs.push(dir);
  return dir;
}

/** PATH fully replaced — isolates agent discovery from whatever is actually installed. */
function isolatedEnv(pathDirs: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    PATHEXT: process.env.PATHEXT,
    PATH: pathDirs.join(path.delimiter),
    ...extra,
  };
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

describe("statusCommand (spec §41: quick, fully offline)", () => {
  it("reports json with nothing installed and no key", () => {
    const home = temp();
    const emptyPath = temp();
    const out = captureStdout();

    const code = statusCommand(
      { json: true },
      { home, env: isolatedEnv([emptyPath]), readUserEnv: () => undefined },
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed.zaiKeyConfigured).toBe(false);
    expect(parsed.claude).toBe("missing");
    expect(parsed.codex).toBe("missing");
    expect(parsed.models.main).toBe("glm-5.3");
  });

  it("reports json as installed/configured once claude, codex, and the key are present", () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, "claude.exe"), "");
    writeFileSyncAll(path.join(dir, "codex.exe"), "");
    const out = captureStdout();

    const code = statusCommand(
      { json: true },
      {
        home,
        env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }),
        readUserEnv: () => undefined,
      },
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed.zaiKeyConfigured).toBe(true);
    expect(parsed.claude).toBe("installed");
    expect(parsed.codex).toBe("installed");
  });

  it("renders human-readable text with the same facts", () => {
    const home = temp();
    const emptyPath = temp();
    const out = captureStdout();

    const code = statusCommand({}, { home, env: isolatedEnv([emptyPath]), readUserEnv: () => undefined });

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("Z.ai key        not configured");
    expect(text).toContain("Claude          missing");
    expect(text).toContain("Codex           missing");
    expect(text).toContain("Main model      glm-5.3");
  });

  it("never makes a network request or prints the key value", () => {
    const home = temp();
    const emptyPath = temp();
    const out = captureStdout();

    statusCommand(
      { json: true },
      { home, env: isolatedEnv([emptyPath], { ZAI_API_KEY: "super-secret-value" }) },
    );

    expect(out.text()).not.toContain("super-secret-value");
  });
});
