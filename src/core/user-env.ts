import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Persistent per-user secret storage (specs/cross-platform.md).
 *
 * The Windows design reads the key from an out-of-process store on *every*
 * invocation and never caches it, because Orca terminals snapshot a stale
 * environment. This module keeps that property on every platform that has a
 * store, and is explicit when there is none.
 */
export type UserEnvStore = "windows-user-env" | "macos-keychain" | "libsecret" | "none";

/** Keychain/libsecret service name; the variable name is the account. */
export const KEY_STORE_SERVICE = "glm-coding-router";

/** Only well-formed variable names may reach a child process (spec §38). */
function assertEnvVarName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}`);
  }
}

export interface UserEnvDeps {
  /** Defaults to process.platform — injected by tests. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to process.env — injected by tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to a real PATH lookup — injected by tests. */
  readonly hasCommand?: (name: string) => boolean;
  /** Defaults to execFileSync — injected by tests. */
  readonly run?: RunCommand;
}

export type RunCommand = (
  file: string,
  args: readonly string[],
  options: { input?: string; capture: boolean },
) => string;

function defaultRun(
  file: string,
  args: readonly string[],
  options: { input?: string; capture: boolean },
): string {
  const result = execFileSync(file, [...args], {
    encoding: "utf8",
    windowsHide: true,
    input: options.input,
    stdio: options.input === undefined
      ? ["ignore", options.capture ? "pipe" : "ignore", "ignore"]
      : ["pipe", options.capture ? "pipe" : "ignore", "ignore"],
  });
  return typeof result === "string" ? result : "";
}

/** Is `name` an executable file somewhere on PATH? */
function defaultHasCommand(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((d) => d.length > 0);
  return dirs.some((dir) => {
    try {
      return fs.statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Which store this machine has. `libsecret` requires `secret-tool` on PATH —
 * it is NOT installed by default on Ubuntu, so "none" is a normal Linux
 * outcome, not an error (specs/cross-platform.md).
 */
export function detectUserEnvStore(deps: UserEnvDeps = {}): UserEnvStore {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const hasCommand = deps.hasCommand ?? ((name: string) => defaultHasCommand(name, env));
  if (platform === "win32") return "windows-user-env";
  if (platform === "darwin") return hasCommand("security") ? "macos-keychain" : "none";
  if (platform === "linux") return hasCommand("secret-tool") ? "libsecret" : "none";
  return "none";
}

/** Human wording for the store, used by key/doctor/uninstall messages. */
export function describeKeyStore(store: UserEnvStore): string {
  switch (store) {
    case "windows-user-env":
      return "Windows User Environment";
    case "macos-keychain":
      return "macOS login keychain";
    case "libsecret":
      return "the system keyring (libsecret)";
    case "none":
      return "no persistent store";
  }
}

/**
 * Read a variable from the per-user store. Returns undefined on any failure —
 * callers fall back or raise their own error.
 */
export function readUserEnv(name: string, deps: UserEnvDeps = {}): string | undefined {
  assertEnvVarName(name);
  const store = detectUserEnvStore(deps);
  const run = deps.run ?? defaultRun;
  try {
    let value: string;
    switch (store) {
      case "windows-user-env":
        value = run(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `[Environment]::GetEnvironmentVariable('${name}','User')`,
          ],
          { capture: true },
        );
        break;
      case "macos-keychain":
        value = run(
          "security",
          ["find-generic-password", "-s", KEY_STORE_SERVICE, "-a", name, "-w"],
          { capture: true },
        );
        break;
      case "libsecret":
        value = run(
          "secret-tool",
          ["lookup", "service", KEY_STORE_SERVICE, "account", name],
          { capture: true },
        );
        break;
      case "none":
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a variable to the per-user store. Throws when there is no store —
 * callers print platform-appropriate guidance instead.
 *
 * The value never goes through a shell. On Windows and Linux it is passed via
 * a child environment variable / stdin respectively, so it never appears in
 * any process's argv. The macOS backend has no stdin form, so the value is in
 * `security`'s argv for the duration of that call — a known limitation of the
 * experimental darwin support (specs/cross-platform.md).
 */
export function writeUserEnv(name: string, value: string, deps: UserEnvDeps = {}): void {
  assertEnvVarName(name);
  const store = detectUserEnvStore(deps);
  const run = deps.run ?? defaultRun;
  switch (store) {
    case "windows-user-env":
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Environment]::SetEnvironmentVariable('${name}', $env:GLM_ROUTER_VALUE, 'User')`,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, GLM_ROUTER_VALUE: value },
        },
      );
      return;
    case "macos-keychain":
      run(
        "security",
        ["add-generic-password", "-U", "-s", KEY_STORE_SERVICE, "-a", name, "-w", value],
        { capture: false },
      );
      return;
    case "libsecret":
      run(
        "secret-tool",
        ["store", "--label", `${KEY_STORE_SERVICE} ${name}`, "service", KEY_STORE_SERVICE, "account", name],
        { input: value, capture: false },
      );
      return;
    case "none":
      throw new Error("no persistent secret store is available on this platform");
  }
}

/** Remove the variable from the per-user store. No store → nothing to do. */
export function deleteUserEnv(name: string, deps: UserEnvDeps = {}): void {
  assertEnvVarName(name);
  const store = detectUserEnvStore(deps);
  const run = deps.run ?? defaultRun;
  switch (store) {
    case "windows-user-env":
      run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`,
        ],
        { capture: false },
      );
      return;
    case "macos-keychain":
      run(
        "security",
        ["delete-generic-password", "-s", KEY_STORE_SERVICE, "-a", name],
        { capture: false },
      );
      return;
    case "libsecret":
      run("secret-tool", ["clear", "service", KEY_STORE_SERVICE, "account", name], {
        capture: false,
      });
      return;
    case "none":
      return;
  }
}

/**
 * The shell line a user must add when there is no store, plus the profile file
 * to put it in. Chosen from $SHELL, preferring a file that already exists.
 */
export function describeShellExport(
  name: string,
  deps: { env?: NodeJS.ProcessEnv; home?: string; exists?: (file: string) => boolean } = {},
): { line: string; profile: string } {
  const env = deps.env ?? process.env;
  const home = deps.home ?? env.HOME ?? "~";
  const exists = deps.exists ?? ((file: string) => fs.existsSync(file));
  const shell = path.posix.basename(env.SHELL ?? "bash");
  const candidates =
    shell === "zsh"
      ? [".zshrc", ".zprofile", ".profile"]
      : shell === "fish"
        ? [".config/fish/config.fish"]
        : [".bashrc", ".bash_profile", ".profile"];
  // POSIX paths by definition: this guidance only ever names a shell rc file,
  // so it must not pick up Windows separators when the process runs on win32.
  const found = candidates.find((rel) => exists(path.posix.join(home, rel)));
  const profile = path.posix.join(home, found ?? candidates[0]);
  const line =
    shell === "fish" ? `set -gx ${name} <your-key>` : `export ${name}="<your-key>"`;
  return { line, profile };
}
