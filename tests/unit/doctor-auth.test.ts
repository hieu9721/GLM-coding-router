import { describe, expect, it } from "vitest";
import { authenticateZaiKey, authenticationCheckStatus, deriveDoctorVerdict, type AuthenticationResult } from "../../src/commands/doctor-auth.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

const ACCEPTED = { code: 200, success: true, data: { level: "lite", limits: [] } };

describe("authenticateZaiKey (specs/terminal-ui-doctor.md §D)", () => {
  it("offline: skipped, checked=false, never calls fetch", async () => {
    let called = false;
    const result = await authenticateZaiKey("key", (async () => {
      called = true;
      return jsonResponse(ACCEPTED);
    }) as typeof fetch, true);
    expect(result).toMatchObject({ state: "skipped", checked: false, reason: "offline" });
    expect(called).toBe(false);
  });

  it("missing key: missing, checked=false, never calls fetch", async () => {
    let called = false;
    const result = await authenticateZaiKey(undefined, (async () => {
      called = true;
      return jsonResponse(ACCEPTED);
    }) as typeof fetch, false);
    expect(result).toMatchObject({ state: "missing", checked: false, reason: "missing-key" });
    expect(called).toBe(false);
  });

  it("accepted: verified", async () => {
    const result = await authenticateZaiKey("key", (async () => jsonResponse(ACCEPTED)) as typeof fetch, false);
    expect(result).toMatchObject({ state: "verified", checked: true, reason: "accepted" });
  });

  it("401/403: rejected", async () => {
    const r401 = await authenticateZaiKey("key", (async () => jsonResponse({}, 401)) as typeof fetch, false);
    expect(r401).toMatchObject({ state: "rejected", reason: "http-401" });
    const r403 = await authenticateZaiKey("key", (async () => jsonResponse({}, 403)) as typeof fetch, false);
    expect(r403).toMatchObject({ state: "rejected", reason: "http-403" });
  });

  it("429/5xx/network/invalid-response/provider: unverified, never rejected", async () => {
    const cases: [typeof fetch, string][] = [
      [(async () => jsonResponse({}, 429)) as typeof fetch, "rate-limited"],
      [(async () => jsonResponse({}, 500)) as typeof fetch, "http-error"],
      [(async () => { throw new TypeError("boom"); }) as typeof fetch, "network-error"],
      [(async () => new Response("<html>", { status: 200 })) as typeof fetch, "invalid-response"],
      [(async () => jsonResponse({ code: 401, msg: "x" })) as typeof fetch, "provider-error"],
    ];
    for (const [fetchImpl, expectedReason] of cases) {
      const result = await authenticateZaiKey("key", fetchImpl, false);
      expect(result.state).toBe("unverified");
      expect(result.reason).toBe(expectedReason);
    }
  });

  it("never includes the key value in the safe detail text", async () => {
    const secret = "very-secret-key-value";
    const result = await authenticateZaiKey(secret, (async () => jsonResponse({}, 401)) as typeof fetch, false);
    expect(result.detail).not.toContain(secret);
  });
});

describe("authenticationCheckStatus", () => {
  it("maps each state to the doctor row status", () => {
    expect(authenticationCheckStatus("verified")).toBe("ok");
    expect(authenticationCheckStatus("rejected")).toBe("fail");
    expect(authenticationCheckStatus("missing")).toBe("fail");
    expect(authenticationCheckStatus("unverified")).toBe("warn");
    expect(authenticationCheckStatus("skipped")).toBe("warn");
  });
});

function auth(state: AuthenticationResult["state"], reason: AuthenticationResult["reason"] = "accepted"): AuthenticationResult {
  return { state, checked: state !== "missing" && state !== "skipped", method: "zai-quota-monitor", reason, detail: "x" };
}

describe("deriveDoctorVerdict (spec §E precedence table)", () => {
  it("local failure always wins, regardless of authentication", () => {
    expect(
      deriveDoctorVerdict({ localFailure: true, authentication: auth("verified"), keyComparison: "match", offline: false }),
    ).toEqual({ status: "ISSUES", exitCode: 1 });
  });

  it("missing key → ISSUES even with local checks passing", () => {
    expect(
      deriveDoctorVerdict({ localFailure: false, authentication: auth("missing", "missing-key"), keyComparison: "not-comparable", offline: false }),
    ).toEqual({ status: "ISSUES", exitCode: 1 });
  });

  it("rejected auth → ISSUES", () => {
    expect(
      deriveDoctorVerdict({ localFailure: false, authentication: auth("rejected", "http-401"), keyComparison: "match", offline: false }),
    ).toEqual({ status: "ISSUES", exitCode: 1 });
  });

  it("unverified auth (online) → UNVERIFIED, exit 1", () => {
    expect(
      deriveDoctorVerdict({ localFailure: false, authentication: auth("unverified", "timeout"), keyComparison: "not-comparable", offline: false }),
    ).toEqual({ status: "UNVERIFIED", exitCode: 1 });
  });

  it("skipped auth via --offline → UNVERIFIED, exit 0", () => {
    expect(
      deriveDoctorVerdict({ localFailure: false, authentication: auth("skipped", "offline"), keyComparison: "not-comparable", offline: true }),
    ).toEqual({ status: "UNVERIFIED", exitCode: 0 });
  });

  it("verified auth but the explicit --network probe failed → UNVERIFIED, exit 1", () => {
    expect(
      deriveDoctorVerdict({
        localFailure: false,
        authentication: auth("verified"),
        keyComparison: "match",
        offline: false,
        networkProbeFailed: true,
      }),
    ).toEqual({ status: "UNVERIFIED", exitCode: 1 });
  });

  it("verified auth + differing sources → ATTENTION, exit 0", () => {
    expect(
      deriveDoctorVerdict({ localFailure: false, authentication: auth("verified"), keyComparison: "different", offline: false }),
    ).toEqual({ status: "ATTENTION", exitCode: 0 });
  });

  it("verified auth + unreadable store comparison → ATTENTION, exit 0", () => {
    expect(
      deriveDoctorVerdict({ localFailure: false, authentication: auth("verified"), keyComparison: "unavailable", offline: false }),
    ).toEqual({ status: "ATTENTION", exitCode: 0 });
  });

  it("verified auth + not-comparable (the normal single-source case) → HEALTHY, exit 0", () => {
    expect(
      deriveDoctorVerdict({ localFailure: false, authentication: auth("verified"), keyComparison: "not-comparable", offline: false }),
    ).toEqual({ status: "HEALTHY", exitCode: 0 });
  });

  it("verified auth + matching sources → HEALTHY, exit 0", () => {
    expect(
      deriveDoctorVerdict({ localFailure: false, authentication: auth("verified"), keyComparison: "match", offline: false }),
    ).toEqual({ status: "HEALTHY", exitCode: 0 });
  });
});
