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

/**
 * Closed set of failure classes (specs/terminal-ui-doctor.md §D). Callers
 * (doctor, usage, dashboard, budget, MCP) must branch on `kind`, never on
 * parsing `message` — the message is safe to print but not a stable contract.
 */
export type ZaiQuotaErrorKind =
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "http"
  | "network"
  | "invalid-response"
  | "provider";

/**
 * Thrown by `fetchZaiQuota` instead of a plain `Error`. `message` is always a
 * safe, locally-constructed string — it never contains the raw response body,
 * a provider `msg`, headers, or a URL with credentials (spec §D "Security").
 */
export class ZaiQuotaError extends Error {
  public readonly kind: ZaiQuotaErrorKind;
  public readonly httpStatus?: number;
  /** Only meaningful when kind === "network": distinguishes a timeout from any other network failure. */
  public readonly timeout: boolean;

  public constructor(
    kind: ZaiQuotaErrorKind,
    message: string,
    options: { httpStatus?: number; timeout?: boolean } = {},
  ) {
    super(message);
    this.name = "ZaiQuotaError";
    this.kind = kind;
    this.httpStatus = options.httpStatus;
    this.timeout = options.timeout ?? false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumberOrAbsent(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

/** Every quota field is optional, but any field that IS present must be well-typed. */
function isValidLimit(entry: unknown): entry is ZaiLimit {
  if (!isPlainObject(entry)) return false;
  if (entry.type !== undefined && typeof entry.type !== "string") return false;
  return (
    isFiniteNumberOrAbsent(entry.unit) &&
    isFiniteNumberOrAbsent(entry.number) &&
    isFiniteNumberOrAbsent(entry.usage) &&
    isFiniteNumberOrAbsent(entry.currentValue) &&
    isFiniteNumberOrAbsent(entry.remaining) &&
    isFiniteNumberOrAbsent(entry.percentage) &&
    isFiniteNumberOrAbsent(entry.nextResetTime)
  );
}

type ParsedQuotaBody =
  | { readonly ok: true; readonly data: ZaiQuotaData }
  | { readonly ok: false; readonly kind: "invalid-response" | "provider"; readonly message: string };

/**
 * Validate the monitor response shape (spec §D "Success validation"). Empty
 * `limits` is a valid, fully-authenticated response meaning "no windows
 * reported" — never treated as zero quota. A missing or wrong-type `limits`
 * field means the schema did not match, which is unverified, not rejected.
 */
function parseQuotaBody(body: unknown): ParsedQuotaBody {
  if (!isPlainObject(body)) {
    return { ok: false, kind: "invalid-response", message: "Z.ai monitor endpoint returned an unexpected response shape." };
  }
  if (typeof body.code !== "number") {
    return { ok: false, kind: "invalid-response", message: "Z.ai monitor endpoint response is missing a status code." };
  }
  if (body.code !== 200) {
    return { ok: false, kind: "provider", message: `Z.ai monitor endpoint rejected the request (code ${body.code}).` };
  }
  if (body.success !== undefined && body.success !== true) {
    return { ok: false, kind: "provider", message: "Z.ai monitor endpoint reported an unsuccessful request." };
  }
  if (!isPlainObject(body.data)) {
    return { ok: false, kind: "invalid-response", message: "Z.ai monitor endpoint response is missing usage data." };
  }
  const data = body.data;
  if (data.level !== undefined && typeof data.level !== "string") {
    return { ok: false, kind: "invalid-response", message: "Z.ai monitor endpoint response has an invalid level field." };
  }
  if (!Array.isArray(data.limits)) {
    return { ok: false, kind: "invalid-response", message: "Z.ai monitor endpoint response is missing usage limits." };
  }
  for (const entry of data.limits) {
    if (!isValidLimit(entry)) {
      return { ok: false, kind: "invalid-response", message: "Z.ai monitor endpoint response contains a malformed limit entry." };
    }
  }
  return {
    ok: true,
    data: { level: data.level as string | undefined, limits: data.limits as readonly ZaiLimit[] },
  };
}

/**
 * Fetch and validate the Z.ai quota snapshot. Never logs the Authorization
 * header. Throws `ZaiQuotaError` on any failure — callers branch on `.kind`.
 * `redirect: "error"` refuses to forward the bearer token to a redirect
 * target (spec §D "Security").
 */
export async function fetchZaiQuota(key: string, fetchImpl: typeof fetch): Promise<ZaiQuotaData> {
  let response: Response;
  try {
    response = await fetchImpl(ZAI_QUOTA_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    throw new ZaiQuotaError(
      "network",
      isTimeout ? "Z.ai monitor endpoint timed out." : "Z.ai monitor endpoint was unreachable.",
      { timeout: isTimeout },
    );
  }

  if (response.status === 401) {
    throw new ZaiQuotaError("unauthorized", "Z.ai monitor endpoint rejected the key (HTTP 401).", {
      httpStatus: 401,
    });
  }
  if (response.status === 403) {
    throw new ZaiQuotaError("forbidden", "Z.ai monitor endpoint denied access (HTTP 403).", {
      httpStatus: 403,
    });
  }
  if (response.status === 429) {
    throw new ZaiQuotaError("rate-limited", "Z.ai monitor endpoint is rate-limiting this key (HTTP 429).", {
      httpStatus: 429,
    });
  }
  if (!response.ok) {
    throw new ZaiQuotaError("http", `Z.ai monitor endpoint returned HTTP ${response.status}.`, {
      httpStatus: response.status,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ZaiQuotaError("invalid-response", "Z.ai monitor endpoint returned a non-JSON body.");
  }

  const parsed = parseQuotaBody(body);
  if (!parsed.ok) {
    throw new ZaiQuotaError(parsed.kind, parsed.message);
  }
  return parsed.data;
}
