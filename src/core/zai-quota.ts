/**
 * The Z.ai monitor endpoint lives in core because four readers need it —
 * usage, dashboard, the MCP server and the Phase E budget manager — and a
 * budget module must not import from a command module: commands sit on top
 * of core, never underneath it.
 */

/** Z.ai monitor API used by their own dashboard (specs/usage.md). */
export const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

/** One CREDIT_LIMIT entry from the monitor API. */
export interface ZaiLimit {
  readonly type?: string;
  readonly unit?: number;
  readonly number?: number;
  readonly usage?: number;
  readonly currentValue?: number;
  readonly remaining?: number;
  readonly percentage?: number;
  readonly nextResetTime?: number;
}

export interface ZaiQuotaData {
  readonly level?: string;
  readonly limits?: readonly ZaiLimit[];
}

/** Window labels for the observed enum values (specs/usage.md); unknown values stay generic. */
export function describeWindow(limit: ZaiLimit): string {
  if (limit.unit === 3 && typeof limit.number === "number") {
    return `${limit.number}-hour window`;
  }
  if (limit.unit === 6 && limit.number === 1) {
    return "weekly";
  }
  return `window unit=${String(limit.unit)} x ${String(limit.number)}`;
}

/** Fetch and validate the Z.ai quota snapshot. Never logs the Authorization header. */
export async function fetchZaiQuota(key: string, fetchImpl: typeof fetch): Promise<ZaiQuotaData> {
  let response: Response;
  try {
    response = await fetchImpl(ZAI_QUOTA_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(`Z.ai monitor endpoint unreachable (${error instanceof Error ? error.message : "network error"})`);
  }
  if (!response.ok) {
    throw new Error(`Z.ai monitor endpoint returned HTTP ${response.status}`);
  }
  let body: { code?: number; msg?: string; data?: ZaiQuotaData; success?: boolean };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new Error("Z.ai monitor endpoint returned a non-JSON body");
  }
  if (body.code !== 200 || typeof body.data !== "object" || body.data === null) {
    throw new Error(`Z.ai monitor endpoint rejected the request (${body.msg ?? `code ${String(body.code)}`})`);
  }
  return body.data;
}
