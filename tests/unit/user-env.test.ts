import { describe, expect, it } from "vitest";
import {
  describeKeyStore,
  describeShellExport,
  detectUserEnvStore,
  readUserEnv,
  readUserEnvDiagnostic,
  writeUserEnv,
  deleteUserEnv,
  type RunCommand,
} from "../../src/core/user-env.js";

/** Records every child invocation instead of running one. */
function recorder(output = ""): { run: RunCommand; calls: { file: string; args: string[]; input?: string }[] } {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const run: RunCommand = (file, args, options) => {
    calls.push({ file, args: [...args], input: options.input });
    return output;
  };
  return { run, calls };
}

const has = (...present: string[]) => (name: string) => present.includes(name);

describe("detectUserEnvStore (specs/cross-platform.md)", () => {
  it("picks the Windows User Environment on win32", () => {
    expect(detectUserEnvStore({ platform: "win32", hasCommand: () => false })).toBe("windows-user-env");
  });

  it("picks the macOS keychain when security exists", () => {
    expect(detectUserEnvStore({ platform: "darwin", hasCommand: has("security") })).toBe("macos-keychain");
  });

  it("picks libsecret only when secret-tool is actually installed", () => {
    expect(detectUserEnvStore({ platform: "linux", hasCommand: has("secret-tool") })).toBe("libsecret");
    // Measured reality: Ubuntu 24.04 runs gnome-keyring but ships no
    // secret-tool, so "none" is a normal Linux outcome, not an error.
    expect(detectUserEnvStore({ platform: "linux", hasCommand: () => false })).toBe("none");
  });

  it("reports no store on an unknown platform", () => {
    expect(detectUserEnvStore({ platform: "freebsd" as NodeJS.Platform, hasCommand: () => true })).toBe("none");
  });
});

describe("readUserEnv", () => {
  it("reads the keychain through security on darwin", () => {
    const { run, calls } = recorder("  secret-value \n");
    const value = readUserEnv("ZAI_API_KEY", {
      platform: "darwin",
      hasCommand: has("security"),
      run,
    });
    expect(value).toBe("secret-value");
    expect(calls[0].file).toBe("security");
    expect(calls[0].args).toEqual([
      "find-generic-password", "-s", "glm-coding-router", "-a", "ZAI_API_KEY", "-w",
    ]);
  });

  it("reads libsecret through secret-tool on linux", () => {
    const { run, calls } = recorder("linux-secret\n");
    expect(
      readUserEnv("ZAI_API_KEY", { platform: "linux", hasCommand: has("secret-tool"), run }),
    ).toBe("linux-secret");
    expect(calls[0].file).toBe("secret-tool");
    expect(calls[0].args).toEqual(["lookup", "service", "glm-coding-router", "account", "ZAI_API_KEY"]);
  });

  it("returns undefined with no store, and never spawns anything", () => {
    const { run, calls } = recorder("ignored");
    expect(readUserEnv("ZAI_API_KEY", { platform: "linux", hasCommand: () => false, run })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("returns undefined when the store command fails", () => {
    const run: RunCommand = () => {
      throw new Error("keyring locked");
    };
    expect(readUserEnv("ZAI_API_KEY", { platform: "darwin", hasCommand: has("security"), run })).toBeUndefined();
  });

  it("rejects malformed variable names before spawning (spec §38)", () => {
    const { run, calls } = recorder();
    expect(() => readUserEnv("BAD-NAME; rm -rf /", { platform: "linux", hasCommand: has("secret-tool"), run }))
      .toThrow(/Invalid environment variable name/);
    expect(calls).toHaveLength(0);
  });
});

describe("readUserEnvDiagnostic (specs/terminal-ui-doctor.md §C)", () => {
  it("is readable with value=undefined when there is no store at all", () => {
    const { run, calls } = recorder("ignored");
    expect(readUserEnvDiagnostic("ZAI_API_KEY", { platform: "linux", hasCommand: () => false, run })).toEqual({
      readable: true,
      value: undefined,
    });
    expect(calls).toHaveLength(0);
  });

  it("is readable with the trimmed value on a normal successful read", () => {
    const { run } = recorder("  secret-value \n");
    expect(
      readUserEnvDiagnostic("ZAI_API_KEY", { platform: "darwin", hasCommand: has("security"), run }),
    ).toEqual({ readable: true, value: "secret-value" });
  });

  it("is readable with value=undefined when the store exists but is empty", () => {
    const { run } = recorder("   \n");
    expect(
      readUserEnvDiagnostic("ZAI_API_KEY", { platform: "darwin", hasCommand: has("security"), run }),
    ).toEqual({ readable: true, value: undefined });
  });

  it("is NOT readable (distinct from empty) when the store command itself fails", () => {
    const run: RunCommand = () => {
      throw new Error("keyring locked");
    };
    expect(
      readUserEnvDiagnostic("ZAI_API_KEY", { platform: "darwin", hasCommand: has("security"), run }),
    ).toEqual({ readable: false, value: undefined });
  });

  it("readUserEnv collapses both empty and unreadable to undefined (unchanged existing contract)", () => {
    const failingRun: RunCommand = () => {
      throw new Error("keyring locked");
    };
    expect(readUserEnv("ZAI_API_KEY", { platform: "darwin", hasCommand: has("security"), run: failingRun })).toBeUndefined();
  });
});

describe("writeUserEnv", () => {
  it("passes the secret to secret-tool on stdin, never in argv", () => {
    const { run, calls } = recorder();
    writeUserEnv("ZAI_API_KEY", "top-secret", {
      platform: "linux",
      hasCommand: has("secret-tool"),
      run,
    });
    expect(calls[0].input).toBe("top-secret");
    expect(calls[0].args.join(" ")).not.toContain("top-secret");
  });

  it("throws when the platform has no store, so callers can print guidance", () => {
    const { run } = recorder();
    expect(() => writeUserEnv("ZAI_API_KEY", "x", { platform: "linux", hasCommand: () => false, run }))
      .toThrow(/no persistent secret store/);
  });
});

describe("deleteUserEnv", () => {
  it("clears the libsecret entry", () => {
    const { run, calls } = recorder();
    deleteUserEnv("ZAI_API_KEY", { platform: "linux", hasCommand: has("secret-tool"), run });
    expect(calls[0].args).toEqual(["clear", "service", "glm-coding-router", "account", "ZAI_API_KEY"]);
  });

  it("is a no-op when there is nothing to clear", () => {
    const { run, calls } = recorder();
    deleteUserEnv("ZAI_API_KEY", { platform: "linux", hasCommand: () => false, run });
    expect(calls).toHaveLength(0);
  });
});

describe("describeKeyStore", () => {
  it("names each store for user-facing messages", () => {
    expect(describeKeyStore("windows-user-env")).toBe("Windows User Environment");
    expect(describeKeyStore("macos-keychain")).toContain("keychain");
    expect(describeKeyStore("libsecret")).toContain("keyring");
    expect(describeKeyStore("none")).toContain("no persistent store");
  });
});

describe("describeShellExport", () => {
  it("prefers an existing rc file for the user's shell", () => {
    const result = describeShellExport("ZAI_API_KEY", {
      env: { SHELL: "/bin/zsh" },
      home: "/home/t",
      exists: (file) => file === "/home/t/.zshrc",
    });
    expect(result.profile).toBe("/home/t/.zshrc");
    expect(result.line).toBe('export ZAI_API_KEY="<your-key>"');
  });

  it("falls back to the shell's primary rc file when none exists yet", () => {
    const result = describeShellExport("ZAI_API_KEY", {
      env: { SHELL: "/bin/bash" },
      home: "/home/t",
      exists: () => false,
    });
    expect(result.profile).toBe("/home/t/.bashrc");
  });

  it("uses fish syntax for fish", () => {
    const result = describeShellExport("ZAI_API_KEY", {
      env: { SHELL: "/usr/bin/fish" },
      home: "/home/t",
      exists: () => false,
    });
    expect(result.line).toBe("set -gx ZAI_API_KEY <your-key>");
    expect(result.profile).toContain("config.fish");
  });
});
