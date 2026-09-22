/**
 * Pure credential-authentication state and doctor verdict logic
 * (specs/terminal-ui-doctor.md §D, §E). Kept separate from doctor-command.ts
 * so the precedence rules are unit-testable without mocking fetch/stdout.
 */
import { ZaiQuotaError, fetchZaiQuota } from "../core/zai-quota.js";
import type { KeyComparison } from "../core/key-inspector.js";
import type { CheckStatus } from "./doctor.js";

export type AuthState = "verified" | "rejected" | "unverified" | "skipped" | "missing";

/** Closed set (spec §D) — treat as an enum, never pattern-match on `detail`. */
export type AuthReason =
  | "accepted"
  | "http-401"
  | "http-403"
  | "rate-limited"
  | "http-error"
  | "timeout"
  | "network-error"
  | "invalid-response"
  | "provider-error"
  | "offline"
  | "missing-key";

export interface AuthenticationResult {
  readonly state: AuthState;
  /** True iff a monitor request was actually attempted. */
  readonly checked: boolean;
  readonly method: "zai-quota-monitor";
  readonly reason: AuthReason;
  /** Safe local message — never the raw response body, provider msg, or headers. */
  readonly detail: string;
}

/**
 * Authenticate exactly the effective key once. Never retries with a
 * different key on rejection (spec §C.6) — that would hide the key the next
 * worker will actually use.
 */
export async function authenticateZaiKey(
  key: string | undefined,
  fetchImpl: typeof fetch,
  offline: boolean,
): Promise<AuthenticationResult> {
  if (offline) {
    return {
      state: "skipped",
      checked: false,
      method: "zai-quota-monitor",
      reason: "offline",
      detail: "Online authentication was not performed (--offline).",
    };
  }
  if (!key) {
    return {
      state: "missing",
      checked: false,
      method: "zai-quota-monitor",
      reason: "missing-key",
      detail: "No ZAI_API_KEY was found in the process environment or the per-user store.",
    };
  }

  try {
    await fetchZaiQuota(key, fetchImpl);
    return {
      state: "verified",
      checked: true,
      method: "zai-quota-monitor",
      reason: "accepted",
      detail: "The Z.ai monitor endpoint accepted the selected key.",
    };
  } catch (error) {
    if (!(error instanceof ZaiQuotaError)) {
      return {
        state: "unverified",
        checked: true,
        method: "zai-quota-monitor",
        reason: "network-error",
        detail: "Authentication could not be completed.",
      };
    }
    switch (error.kind) {
      case "unauthorized":
        return { state: "rejected", checked: true, method: "zai-quota-monitor", reason: "http-401", detail: error.message };
      case "forbidden":
        return { state: "rejected", checked: true, method: "zai-quota-monitor", reason: "http-403", detail: error.message };
      case "rate-limited":
        return { state: "unverified", checked: true, method: "zai-quota-monitor", reason: "rate-limited", detail: error.message };
      case "http":
        return { state: "unverified", checked: true, method: "zai-quota-monitor", reason: "http-error", detail: error.message };
      case "network":
        return {
          state: "unverified",
          checked: true,
          method: "zai-quota-monitor",
          reason: error.timeout ? "timeout" : "network-error",
          detail: error.message,
        };
      case "invalid-response":
        return { state: "unverified", checked: true, method: "zai-quota-monitor", reason: "invalid-response", detail: error.message };
      case "provider":
        return { state: "unverified", checked: true, method: "zai-quota-monitor", reason: "provider-error", detail: error.message };
    }
  }
}

/** The Credentials-section row status for the authentication check (spec §D table's "Check" column). */
export function authenticationCheckStatus(state: AuthState): CheckStatus {
  switch (state) {
    case "verified":
      return "ok";
    case "rejected":
    case "missing":
      return "fail";
    case "unverified":
    case "skipped":
      return "warn";
  }
}

export type DoctorStatus = "HEALTHY" | "ATTENTION" | "UNVERIFIED" | "ISSUES";

export interface DoctorVerdict {
  readonly status: DoctorStatus;
  readonly exitCode: number;
}

/**
 * Overall summary precedence (spec §E, first matching row wins). `networkProbeFailed`
 * only applies when `--network` was explicitly requested; it is `false`/`undefined`
 * whenever that probe was not run or came back reachable.
 */
export function deriveDoctorVerdict(input: {
  readonly localFailure: boolean;
  readonly authentication: AuthenticationResult;
  readonly keyComparison: KeyComparison;
  readonly offline: boolean;
  readonly networkProbeFailed?: boolean;
}): DoctorVerdict {
  const { localFailure, authentication, keyComparison, offline, networkProbeFailed } = input;

  if (localFailure || authentication.state === "missing" || authentication.state === "rejected") {
    return { status: "ISSUES", exitCode: 1 };
  }

  if (authentication.state === "unverified" || authentication.state === "skipped" || networkProbeFailed) {
    const exitCode = offline && authentication.state === "skipped" ? 0 : 1;
    return { status: "UNVERIFIED", exitCode };
  }

  // authentication.state === "verified" from here on.
  if (keyComparison === "different" || keyComparison === "unavailable") {
    return { status: "ATTENTION", exitCode: 0 };
  }

  return { status: "HEALTHY", exitCode: 0 };
}
