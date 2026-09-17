import { execFileSync } from "node:child_process";

export const ZAI_API_KEY_ENV = "ZAI_API_KEY";

export type ZaiKeySource = "process-env" | "windows-user-env";

export interface ResolvedZaiKey {
  readonly key: string;
  readonly source: ZaiKeySource;
}

/** Only well-formed variable names may reach powershell.exe (spec §38). */
function assertEnvVarName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}`);
  }
}

/**
 * Read a variable from the Windows User Environment via PowerShell (spec §10).
 * Returns undefined on any failure — callers fall back or fail with their own error.
 */
export function readWindowsUserEnv(name: string): string | undefined {
  assertEnvVarName(name);
  try {
    const result = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Environment]::GetEnvironmentVariable('${name}','User')`,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const value = result.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a variable to the Windows User Environment (spec §11).
 * The value is passed through a child-process env var so it never needs
 * PowerShell string escaping (spec §38: no unescaped user data in commands).
 */
export function setWindowsUserEnv(name: string, value: string): void {
  assertEnvVarName(name);
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
}

export function deleteWindowsUserEnv(name: string): void {
  assertEnvVarName(name);
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`,
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

export interface ResolveZaiKeyOptions {
  /** Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to readWindowsUserEnv. */
  readonly readUserEnv?: (name: string) => string | undefined;
}

/**
 * Resolve the Z.ai key with the mandatory fallback order (spec §10):
 *   1. process.env.ZAI_API_KEY
 *   2. Windows User Environment
 *   3. fail (undefined)
 *
 * The fallback exists because Orca terminals snapshot a stale environment and
 * cannot see keys added after startup. Never cache the key to disk.
 */
export function resolveZaiApiKey(options: ResolveZaiKeyOptions = {}): ResolvedZaiKey | undefined {
  const env = options.env ?? process.env;
  const readUserEnv = options.readUserEnv ?? readWindowsUserEnv;

  const fromProcess = env[ZAI_API_KEY_ENV];
  if (fromProcess && fromProcess.trim()) {
    return { key: fromProcess.trim(), source: "process-env" };
  }

  const fromUserEnv = readUserEnv(ZAI_API_KEY_ENV);
  if (fromUserEnv && fromUserEnv.trim()) {
    return { key: fromUserEnv.trim(), source: "windows-user-env" };
  }

  return undefined;
}
