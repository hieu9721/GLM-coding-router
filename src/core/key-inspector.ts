/**
 * Two-source credential comparison for `doctor` (specs/terminal-ui-doctor.md
 * §C). This module never changes runtime key precedence — `resolveZaiApiKey`
 * in zai-key.ts remains the single source of truth for which key an agent
 * actually uses. It only *observes* both sources once, privately, so doctor
 * can warn when the process value that wins is stale.
 *
 * `effectiveKey` on the returned snapshot is the real secret value. Never put
 * it in a `DoctorReport`, JSON payload, log line or thrown error — only the
 * `comparison` / `keyMismatch` / `effectiveSource` fields are safe to expose.
 */
import { detectUserEnvStore, readUserEnvDiagnostic, type UserEnvStore } from "./user-env.js";
import { ZAI_API_KEY_ENV, type ZaiKeySource } from "./zai-key.js";

/**
 * `not-comparable`: only one source has a value (or none do) — the normal
 * single-source case, not a warning.
 * `unavailable`: the store could not be read at all, so a mismatch cannot be
 * ruled out — doctor treats this conservatively, same as `different`.
 */
export type KeyComparison = "match" | "different" | "not-comparable" | "unavailable";

export interface KeyInspection {
  /** The real secret value — never expose outside this module's caller. */
  readonly effectiveKey: string | undefined;
  readonly effectiveSource: ZaiKeySource | undefined;
  readonly comparison: KeyComparison;
  readonly keyMismatch: boolean | null;
  readonly store: UserEnvStore;
}

export interface InspectZaiKeyOptions {
  /** Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to this platform's diagnostic store reader. */
  readonly readUserEnvDiagnostic?: (name: string) => { readable: boolean; value: string | undefined };
  readonly store?: UserEnvStore;
}

/**
 * Read both sources once and compare them without changing which one wins.
 * Precedence mirrors `resolveZaiApiKey`: process environment, then the
 * per-user store.
 */
export function inspectZaiKey(options: InspectZaiKeyOptions = {}): KeyInspection {
  const env = options.env ?? process.env;
  const store = options.store ?? detectUserEnvStore();
  const diagnose = options.readUserEnvDiagnostic ?? ((name: string) => readUserEnvDiagnostic(name));

  const rawProcess = env[ZAI_API_KEY_ENV];
  const processValue = rawProcess && rawProcess.trim() ? rawProcess.trim() : undefined;

  const storeResult = diagnose(ZAI_API_KEY_ENV);
  const storeValue = storeResult.value;

  const effectiveKey = processValue ?? storeValue;
  const effectiveSource: ZaiKeySource | undefined = processValue
    ? "process-env"
    : storeValue
      ? "user-store"
      : undefined;

  let comparison: KeyComparison;
  if (!storeResult.readable) {
    comparison = "unavailable";
  } else if (processValue && storeValue) {
    comparison = processValue === storeValue ? "match" : "different";
  } else {
    comparison = "not-comparable";
  }

  const keyMismatch: boolean | null =
    comparison === "different" ? true : comparison === "match" ? false : null;

  return { effectiveKey, effectiveSource, comparison, keyMismatch, store };
}
