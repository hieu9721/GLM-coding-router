import { describe, expect, it, vi } from "vitest";
import { ZaiQuotaError, fetchZaiQuota, ZAI_QUOTA_URL, describeWindow } from "../../src/core/zai-quota.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

const ACCEPTED = { code: 200, success: true, data: { level: "lite", limits: [] } };

describe("fetchZaiQuota (specs/terminal-ui-doctor.md §D)", () => {
  it("resolves the quota data on a well-formed accepted response", async () => {
    const data = await fetchZaiQuota(
      "key",
      (async () => jsonResponse({ code: 200, data: { level: "lite", limits: [{ unit: 3, number: 5 }] } })) as typeof fetch,
    );
    expect(data.level).toBe("lite");
    expect(data.limits).toEqual([{ unit: 3, number: 5 }]);
  });

  it("accepts an empty limits array as valid — never treated as zero quota", async () => {
    const data = await fetchZaiQuota("key", (async () => jsonResponse(ACCEPTED)) as typeof fetch);
    expect(data.limits).toEqual([]);
  });

  it("accepts a legacy payload that omits success", async () => {
    const data = await fetchZaiQuota(
      "key",
      (async () => jsonResponse({ code: 200, data: { limits: [] } })) as typeof fetch,
    );
    expect(data.limits).toEqual([]);
  });

  it("passes redirect: error and never follows a redirect target with the bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(ACCEPTED));
    await fetchZaiQuota("key", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(
      ZAI_QUOTA_URL,
      expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer key" }) }),
    );
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate-limited"],
  ] as const)("maps HTTP %i to kind %s", async (status, kind) => {
    const error = await fetchZaiQuota("key", (async () => jsonResponse({}, status)) as typeof fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZaiQuotaError);
    expect((error as ZaiQuotaError).kind).toBe(kind);
    expect((error as ZaiQuotaError).httpStatus).toBe(status);
  });

  it("maps an unexpected HTTP status to kind http", async () => {
    const error = await fetchZaiQuota("key", (async () => jsonResponse({}, 500)) as typeof fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZaiQuotaError);
    expect((error as ZaiQuotaError).kind).toBe("http");
  });

  it("maps a thrown fetch exception to kind network, timeout=false", async () => {
    const error = await fetchZaiQuota("key", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZaiQuotaError);
    expect((error as ZaiQuotaError).kind).toBe("network");
    expect((error as ZaiQuotaError).timeout).toBe(false);
  });

  it("marks a TimeoutError distinctly as kind network, timeout=true", async () => {
    const error = await fetchZaiQuota("key", (async () => {
      const err = new DOMException("The operation was aborted", "TimeoutError");
      throw err;
    }) as typeof fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZaiQuotaError);
    expect((error as ZaiQuotaError).kind).toBe("network");
    expect((error as ZaiQuotaError).timeout).toBe(true);
  });

  it("maps a non-JSON body to kind invalid-response", async () => {
    const error = await fetchZaiQuota(
      "key",
      (async () => new Response("<html>", { status: 200 })) as typeof fetch,
    ).catch((e: unknown) => e);
    expect((error as ZaiQuotaError).kind).toBe("invalid-response");
  });

  it.each([null, [], "a string", 42])("maps a non-object body (%j) to kind invalid-response", async (body) => {
    const error = await fetchZaiQuota("key", (async () => jsonResponse(body)) as typeof fetch).catch((e: unknown) => e);
    expect((error as ZaiQuotaError).kind).toBe("invalid-response");
  });

  it("maps a non-200 code to kind provider, without leaking the provider msg", async () => {
    const error = await fetchZaiQuota(
      "key",
      (async () => jsonResponse({ code: 401, msg: "very specific secret-adjacent text" })) as typeof fetch,
    ).catch((e: unknown) => e);
    expect((error as ZaiQuotaError).kind).toBe("provider");
    expect((error as ZaiQuotaError).message).not.toContain("secret-adjacent");
  });

  it("maps success:false to kind provider", async () => {
    const error = await fetchZaiQuota(
      "key",
      (async () => jsonResponse({ code: 200, success: false, data: { limits: [] } })) as typeof fetch,
    ).catch((e: unknown) => e);
    expect((error as ZaiQuotaError).kind).toBe("provider");
  });

  it("maps missing data to kind invalid-response", async () => {
    const error = await fetchZaiQuota("key", (async () => jsonResponse({ code: 200 })) as typeof fetch).catch(
      (e: unknown) => e,
    );
    expect((error as ZaiQuotaError).kind).toBe("invalid-response");
  });

  it("maps missing limits (field absent) to kind invalid-response", async () => {
    const error = await fetchZaiQuota(
      "key",
      (async () => jsonResponse({ code: 200, data: { level: "lite" } })) as typeof fetch,
    ).catch((e: unknown) => e);
    expect((error as ZaiQuotaError).kind).toBe("invalid-response");
  });

  it("maps wrong-type limits to kind invalid-response", async () => {
    const error = await fetchZaiQuota(
      "key",
      (async () => jsonResponse({ code: 200, data: { limits: "not-an-array" } })) as typeof fetch,
    ).catch((e: unknown) => e);
    expect((error as ZaiQuotaError).kind).toBe("invalid-response");
  });

  it("maps a malformed limit entry (wrong numeric type) to kind invalid-response", async () => {
    const error = await fetchZaiQuota(
      "key",
      (async () => jsonResponse({ code: 200, data: { limits: [{ unit: "three" }] } })) as typeof fetch,
    ).catch((e: unknown) => e);
    expect((error as ZaiQuotaError).kind).toBe("invalid-response");
  });

  it("maps a wrong-type level field to kind invalid-response", async () => {
    const error = await fetchZaiQuota(
      "key",
      (async () => jsonResponse({ code: 200, data: { level: 5, limits: [] } })) as typeof fetch,
    ).catch((e: unknown) => e);
    expect((error as ZaiQuotaError).kind).toBe("invalid-response");
  });

  it("never includes the key or an Authorization value in any thrown message", async () => {
    const secret = "sk-super-secret-value";
    const error = await fetchZaiQuota(secret, (async () => jsonResponse({}, 401)) as typeof fetch).catch(
      (e: unknown) => e,
    );
    expect((error as ZaiQuotaError).message).not.toContain(secret);
  });
});

describe("describeWindow", () => {
  it("labels known unit/number combinations", () => {
    expect(describeWindow({ unit: 3, number: 5 })).toBe("5-hour window");
    expect(describeWindow({ unit: 6, number: 1 })).toBe("weekly");
  });

  it("falls back to a generic label for unknown combinations", () => {
    expect(describeWindow({ unit: 9, number: 2 })).toBe("window unit=9 x 2");
  });
});
