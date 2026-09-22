import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { doctorCommand, probeEndpoint } from "../../src/commands/doctor-command.js";
import { makeTempDir, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";
import { exeName } from "../helpers/platform.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-doctor-command-test-");
  dirs.push(dir);
  return dir;
}

/** PATH fully replaced — isolates agent discovery from whatever is actually installed. */
function isolatedEnv(pathDirs: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    PATHEXT: process.env.PATHEXT,
    PATH: pathDirs.join(path.delimiter),
    ...extra,
  };
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

function fakeFetch(status: number): typeof fetch {
  return vi.fn().mockResolvedValue({ status }) as unknown as typeof fetch;
}

function throwingFetch(): typeof fetch {
  return vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
}

/** A minimally valid, accepted monitor response (spec §D "Success validation"). */
const ACCEPTED_PAYLOAD = { code: 200, success: true, data: { level: "lite", limits: [] } };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/** Routes by URL so a single fetchImpl can answer both the monitor and the endpoint probe. */
function routedFetch(quota: () => Promise<Response>, endpointStatus = 200): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL) => {
    const href = typeof input === "string" ? input : input.toString();
    calls.push(href);
    if (href.includes("monitor/usage/quota")) return quota();
    return new Response(null, { status: endpointStatus });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/**
 * SAFETY: every test must supply this explicitly or through `baseDeps` below.
 * Leaving `readUserEnvDiagnostic` unset falls through to the REAL per-user
 * store reader, which on a developer's own machine reads the REAL saved
 * ZAI_API_KEY — do not let a doctor test touch the real secret store.
 */
function noStoreDiagnostic(value: string | undefined = undefined): { readable: boolean; value: string | undefined } {
  return { readable: true, value };
}

interface Deps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  readUserEnv?: (name: string) => string | undefined;
  readUserEnvDiagnostic?: (name: string) => { readable: boolean; value: string | undefined };
  fetchImpl?: typeof fetch;
  store?: "windows-user-env" | "macos-keychain" | "libsecret" | "none";
  platform?: NodeJS.Platform;
}

function baseDeps(overrides: Deps = {}): Deps {
  return {
    readUserEnv: overrides.readUserEnv ?? (() => undefined),
    readUserEnvDiagnostic: overrides.readUserEnvDiagnostic ?? (() => noStoreDiagnostic()),
    store: overrides.store ?? "none",
    platform: overrides.platform ?? "win32",
    ...overrides,
  };
}

describe("probeEndpoint (spec §42)", () => {
  it("reports reachable for a 2xx/4xx response (auth errors still prove reachability)", async () => {
    await expect(probeEndpoint("https://api.z.ai/api/anthropic", fakeFetch(401))).resolves.toBe(
      "reachable",
    );
  });

  it("reports reachable with errors for a 5xx response", async () => {
    await expect(probeEndpoint("https://api.z.ai/api/anthropic", fakeFetch(503))).resolves.toBe(
      "reachable with errors (HTTP 503)",
    );
  });

  it("reports not reachable when the request throws", async () => {
    await expect(probeEndpoint("https://api.z.ai/api/anthropic", throwingFetch())).resolves.toBe(
      "not reachable",
    );
  });
});

describe("doctorCommand (specs/terminal-ui-doctor.md)", () => {
  it("--offline and --network together is an argument error (exit 2)", async () => {
    await expect(
      doctorCommand({ offline: true, network: true }, baseDeps({ home: temp(), env: {} })),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("--offline: UNVERIFIED (authentication skipped), exit 0, no fetch call, when local checks pass", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();
    const fetchSpy = vi.fn();

    const code = await doctorCommand(
      { json: true, offline: true },
      baseDeps({ home, env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }), fetchImpl: fetchSpy as unknown as typeof fetch }),
    );

    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(out.text());
    expect(parsed.status).toBe("UNVERIFIED");
    expect(parsed.authentication.state).toBe("skipped");
    expect(parsed.authentication.checked).toBe(false);
  });

  it("--offline: ISSUES, exit 1, when a required local check still fails", async () => {
    const home = temp();
    const emptyPath = temp();
    const out = captureStdout();

    const code = await doctorCommand(
      { json: true, offline: true },
      baseDeps({ home, env: isolatedEnv([emptyPath]) }),
    );

    expect(code).toBe(1);
    expect(JSON.parse(out.text()).status).toBe("ISSUES");
  });

  it("HEALTHY, exit 0: monitor accepts the key and there is nothing to compare it against", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();

    const code = await doctorCommand(
      { json: true },
      baseDeps({
        home,
        env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }),
        fetchImpl: (async () => jsonResponse(ACCEPTED_PAYLOAD)) as typeof fetch,
      }),
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed.status).toBe("HEALTHY");
    expect(parsed.keySource).toBe("process-env");
    expect(parsed.authentication).toMatchObject({ state: "verified", checked: true, reason: "accepted" });
    expect(parsed.keyComparison).toBe("not-comparable");
    expect(parsed.keyMismatch).toBeNull();
  });

  it("ISSUES, exit 1: missing key never calls the monitor", async () => {
    const home = temp();
    const emptyPath = temp();
    const out = captureStdout();
    const fetchSpy = vi.fn();

    const code = await doctorCommand(
      { json: true },
      baseDeps({ home, env: isolatedEnv([emptyPath]), fetchImpl: fetchSpy as unknown as typeof fetch }),
    );

    expect(code).toBe(1);
    const parsed = JSON.parse(out.text());
    expect(parsed.status).toBe("ISSUES");
    expect(parsed.authentication).toMatchObject({ state: "missing", checked: false, reason: "missing-key" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ISSUES, exit 1: the monitor rejects the key (401)", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();

    const code = await doctorCommand(
      { json: true },
      baseDeps({
        home,
        env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }),
        fetchImpl: fakeFetch(401),
      }),
    );

    expect(code).toBe(1);
    const parsed = JSON.parse(out.text());
    expect(parsed.status).toBe("ISSUES");
    expect(parsed.authentication).toMatchObject({ state: "rejected", reason: "http-401" });
  });

  it("ATTENTION, exit 0: monitor accepts the key but the process value differs from the saved one", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();

    const code = await doctorCommand(
      { json: true },
      baseDeps({
        home,
        env: isolatedEnv([dir], { ZAI_API_KEY: "process-key" }),
        store: "windows-user-env",
        readUserEnvDiagnostic: () => noStoreDiagnostic("stored-key"),
        fetchImpl: (async () => jsonResponse(ACCEPTED_PAYLOAD)) as typeof fetch,
      }),
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed.status).toBe("ATTENTION");
    expect(parsed.keyComparison).toBe("different");
    expect(parsed.keyMismatch).toBe(true);
  });

  it("ATTENTION, exit 0: monitor accepts the key but the store could not be read for comparison", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();

    const code = await doctorCommand(
      { json: true },
      baseDeps({
        home,
        env: isolatedEnv([dir], { ZAI_API_KEY: "process-key" }),
        store: "windows-user-env",
        readUserEnvDiagnostic: () => ({ readable: false, value: undefined }),
        fetchImpl: (async () => jsonResponse(ACCEPTED_PAYLOAD)) as typeof fetch,
      }),
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed.status).toBe("ATTENTION");
    expect(parsed.keyComparison).toBe("unavailable");
    expect(parsed.keyMismatch).toBeNull();
  });

  it("UNVERIFIED, exit 1: rate limited (429) does not claim the key is invalid", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();

    const code = await doctorCommand(
      { json: true },
      baseDeps({ home, env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }), fetchImpl: fakeFetch(429) }),
    );

    expect(code).toBe(1);
    const parsed = JSON.parse(out.text());
    expect(parsed.status).toBe("UNVERIFIED");
    expect(parsed.authentication).toMatchObject({ state: "unverified", reason: "rate-limited" });
  });

  it("UNVERIFIED, exit 1: a network exception does not claim the key is invalid", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();

    const code = await doctorCommand(
      { json: true },
      baseDeps({ home, env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }), fetchImpl: throwingFetch() }),
    );

    expect(code).toBe(1);
    expect(JSON.parse(out.text()).authentication).toMatchObject({ state: "unverified", reason: "network-error" });
  });

  it("includes the network probe result in JSON output when --network is passed, alongside authentication", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();
    const { fn } = routedFetch(async () => jsonResponse(ACCEPTED_PAYLOAD), 200);

    const code = await doctorCommand(
      { json: true, network: true },
      baseDeps({ home, env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }), fetchImpl: fn }),
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed.network).toBe("reachable");
    expect(parsed.authentication.state).toBe("verified");
  });

  it("never probes the endpoint reachability URL when --network is not passed (only the mandatory auth check runs)", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    captureStdout();
    const { fn, calls } = routedFetch(async () => jsonResponse(ACCEPTED_PAYLOAD));

    await doctorCommand({}, baseDeps({ home, env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }), fetchImpl: fn }));

    expect(calls).toEqual(["https://api.z.ai/api/monitor/usage/quota/limit"]);
  });

  it("renders human-readable text with [OK]/[FAIL] tags, a Credentials section and a RESULT line", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();

    const code = await doctorCommand(
      {},
      baseDeps({
        home,
        env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }),
        fetchImpl: (async () => jsonResponse(ACCEPTED_PAYLOAD)) as typeof fetch,
      }),
    );

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("DOCTOR");
    expect(text).toContain("[OK]");
    expect(text).toContain("CREDENTIALS");
    expect(text).toContain(path.join(dir, exeName("claude")));
    expect(text).toMatch(/RESULT\s+HEALTHY/);
  });

  it("renders a Network section in text output when --network is passed and it fails, without calling it authentication", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();
    const { fn } = routedFetch(async () => jsonResponse(ACCEPTED_PAYLOAD), 503);

    await doctorCommand(
      { network: true },
      baseDeps({ home, env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }), fetchImpl: fn }),
    );

    const text = out.text();
    expect(text).toContain("NETWORK");
    expect(text).toContain("reachable with errors");
    expect(text).toMatch(/RESULT\s+UNVERIFIED/);
  });

  it("never prints either the process or the saved key value in JSON or text output", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const jsonOut = captureStdout();

    await doctorCommand(
      { json: true },
      baseDeps({
        home,
        env: isolatedEnv([dir], { ZAI_API_KEY: "super-secret-process-value" }),
        store: "windows-user-env",
        readUserEnvDiagnostic: () => noStoreDiagnostic("super-secret-stored-value"),
        fetchImpl: fakeFetch(401),
      }),
    );
    expect(jsonOut.text()).not.toContain("super-secret-process-value");
    expect(jsonOut.text()).not.toContain("super-secret-stored-value");

    const textOut = captureStdout();
    await doctorCommand(
      {},
      baseDeps({
        home,
        env: isolatedEnv([dir], { ZAI_API_KEY: "super-secret-process-value" }),
        store: "windows-user-env",
        readUserEnvDiagnostic: () => noStoreDiagnostic("super-secret-stored-value"),
        fetchImpl: fakeFetch(401),
      }),
    );
    expect(textOut.text()).not.toContain("super-secret-process-value");
    expect(textOut.text()).not.toContain("super-secret-stored-value");
  });
});
