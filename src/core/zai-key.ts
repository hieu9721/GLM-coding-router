import {
  deleteUserEnv,
  detectUserEnvStore,
  readUserEnv as readUserEnvStore,
  writeUserEnv,
  type UserEnvDeps,
} from "./user-env.js";

export const ZAI_API_KEY_ENV = "ZAI_API_KEY";

/**
 * Where the key came from. `user-store` covers every persistent per-user store
 * (Windows User Environment, macOS keychain, libsecret) — `describeKeyStore()`
 * in user-env.ts names the concrete one (specs/cross-platform.md).
 */
export type ZaiKeySource = "process-env" | "user-store";

export interface ResolvedZaiKey {
  readonly key: string;
  readonly source: ZaiKeySource;
}

/**
 * Read the variable from this platform's per-user store (spec §10).
 * The Windows implementation is unchanged; it now lives in user-env.ts.
 */
export function readWindowsUserEnv(name: string, deps: UserEnvDeps = {}): string | undefined {
  return readUserEnvStore(name, deps);
}

/** Write the variable to this platform's per-user store (spec §11). */
export function setWindowsUserEnv(name: string, value: string, deps: UserEnvDeps = {}): void {
  writeUserEnv(name, value, deps);
}

export function deleteWindowsUserEnv(name: string, deps: UserEnvDeps = {}): void {
  deleteUserEnv(name, deps);
}

/** Re-exported so callers do not need two imports. */
export { detectUserEnvStore };

export interface ResolveZaiKeyOptions {
  /** Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to this platform's user store reader. */
  readonly readUserEnv?: (name: string) => string | undefined;
}

/**
 * Resolve the Z.ai key with the mandatory fallback order (spec §10):
 *   1. process.env.ZAI_API_KEY
 *   2. this platform's per-user store
 *   3. fail (undefined)
 *
 * The fallback exists because Orca terminals snapshot a stale environment and
 * cannot see keys added after startup. Never cache the key to disk.
 */
export function resolveZaiApiKey(options: ResolveZaiKeyOptions = {}): ResolvedZaiKey | undefined {
  const env = options.env ?? process.env;
  const readUserEnv = options.readUserEnv ?? ((name: string) => readUserEnvStore(name));

  const fromProcess = env[ZAI_API_KEY_ENV];
  if (fromProcess && fromProcess.trim()) {
    return { key: fromProcess.trim(), source: "process-env" };
  }

  const fromUserEnv = readUserEnv(ZAI_API_KEY_ENV);
  if (fromUserEnv && fromUserEnv.trim()) {
    return { key: fromUserEnv.trim(), source: "user-store" };
  }

  return undefined;
}
