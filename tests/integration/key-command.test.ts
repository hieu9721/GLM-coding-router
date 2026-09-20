import { afterEach, describe, expect, it, vi } from "vitest";
import {
  keyCheckCommand,
  keyRemoveCommand,
  keySetCommand,
} from "../../src/commands/key.js";
import { ZAI_API_KEY_ENV } from "../../src/core/zai-key.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

function captureStderr(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

describe("keySetCommand (spec §11)", () => {
  it("saves the trimmed key via setEnv and exits 0", async () => {
    const setEnv = vi.fn();

    const code = await keySetCommand(
      {},
      { prompt: async () => ({ key: "  test-key  " }), setEnv, store: "windows-user-env" },
    );

    expect(code).toBe(0);
    expect(setEnv).toHaveBeenCalledTimes(1);
    expect(setEnv).toHaveBeenCalledWith(ZAI_API_KEY_ENV, "test-key");
  });

  // specs/cross-platform.md: no store (the common Linux case) is guidance,
  // not an error — it must never prompt for a secret it cannot save.
  it("prints the shell export guidance and exits 0 when there is no store", async () => {
    const setEnv = vi.fn();
    const prompt = vi.fn();
    const out = captureStdout();
    const code = await keySetCommand(
      {},
      { prompt, setEnv, store: "none", env: { SHELL: "/bin/bash", HOME: "/home/tester" }, home: "/home/tester" },
    );

    expect(code).toBe(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(setEnv).not.toHaveBeenCalled();
    expect(out.text()).toContain('export ZAI_API_KEY="<your-key>"');
    expect(out.text()).toContain("/home/tester/.bashrc");
    expect(out.text()).not.toContain("requires Windows");
  });

  it("exits 1 without touching setEnv when the prompt is cancelled", async () => {
    const setEnv = vi.fn();

    const code = await keySetCommand(
      {},
      { prompt: async () => ({ key: undefined }), setEnv, store: "windows-user-env" },
    );

    expect(code).toBe(1);
    expect(setEnv).not.toHaveBeenCalled();
  });
});

describe("keyCheckCommand (spec §11)", () => {
  it("reports a key found in the process environment and exits 0", () => {
    const out = captureStdout();

    const code = keyCheckCommand(
      {},
      { env: { [ZAI_API_KEY_ENV]: "test-key" } },
    );

    expect(code).toBe(0);
    expect(out.text()).toContain("configured");
    expect(out.text()).toContain("process environment");
  });

  it("exits 10 with ZAI_KEY_MISSING on stderr when no key resolves", () => {
    const err = captureStderr();

    const code = keyCheckCommand(
      {},
      { env: {}, readUserEnv: () => undefined },
    );

    expect(code).toBe(10);
    expect(err.text()).toContain("ZAI_KEY_MISSING");
  });
});

describe("keyRemoveCommand (spec §44)", () => {
  it("deletes the Z.ai key variable via deleteEnv", async () => {
    const deleteEnv = vi.fn();

    await keyRemoveCommand({ deleteEnv, store: "windows-user-env" });

    expect(deleteEnv).toHaveBeenCalledWith(ZAI_API_KEY_ENV);
  });
});

describe("keyRemoveCommand with no store (specs/cross-platform.md)", () => {
  it("does not call deleteEnv and explains where the key actually lives", async () => {
    const deleteEnv = vi.fn();
    const out = captureStdout();
    await keyRemoveCommand({ deleteEnv, store: "none" });
    expect(deleteEnv).not.toHaveBeenCalled();
    expect(out.text()).toContain("shell profile");
  });
});
