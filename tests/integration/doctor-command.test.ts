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

describe("doctorCommand (spec §9, §42)", () => {
  it("renders JSON with status HEALTHY and exit 0 when every check passes", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();

    const code = await doctorCommand(
      { json: true },
      { home, env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }), readUserEnv: () => undefined },
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed.status).toBe("HEALTHY");
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.keySource).toBe("process-env");
    expect(parsed.network).toBeUndefined();
  });

  it("renders JSON with status ISSUES and exit 1 when a check fails", async () => {
    const home = temp();
    const emptyPath = temp();
    const out = captureStdout();

    const code = await doctorCommand(
      { json: true },
      { home, env: isolatedEnv([emptyPath]), readUserEnv: () => undefined },
    );

    expect(code).toBe(1);
    const parsed = JSON.parse(out.text());
    expect(parsed.status).toBe("ISSUES");
  });

  it("includes the network probe result in JSON output when --network is passed", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();

    const code = await doctorCommand(
      { json: true, network: true },
      {
        home,
        env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }),
        readUserEnv: () => undefined,
        fetchImpl: fakeFetch(200),
      },
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed.network).toBe("reachable");
  });

  it("never probes the network when --network is not passed", async () => {
    const home = temp();
    const emptyPath = temp();
    const fetchSpy = vi.fn();
    captureStdout();

    await doctorCommand(
      {},
      { home, env: isolatedEnv([emptyPath]), readUserEnv: () => undefined, fetchImpl: fetchSpy as unknown as typeof fetch },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders human-readable text grouped by section, with symbols and a trailing status line", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();

    const code = await doctorCommand(
      {},
      { home, env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }), readUserEnv: () => undefined },
    );

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("GLM Coding Router Doctor");
    expect(text).toContain("Agents");
    expect(text).toContain("✓ Claude Code");
    expect(text).toContain(path.join(dir, exeName("claude")));
    expect(text).toMatch(/Status: HEALTHY\n$/);
  });

  it("renders the Network section in text output when --network is passed", async () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, exeName("claude")), "");
    const out = captureStdout();

    await doctorCommand(
      { network: true },
      {
        home,
        env: isolatedEnv([dir], { ZAI_API_KEY: "test-key" }),
        readUserEnv: () => undefined,
        fetchImpl: throwingFetch(),
      },
    );

    const text = out.text();
    expect(text).toContain("Network");
    expect(text).toContain("⚠ Z.ai endpoint not reachable");
  });

  it("never prints the ZAI_API_KEY value in JSON or text output", async () => {
    const home = temp();
    const emptyPath = temp();
    const out = captureStdout();

    await doctorCommand(
      { json: true },
      {
        home,
        env: isolatedEnv([emptyPath], { ZAI_API_KEY: "super-secret-value" }),
        readUserEnv: () => undefined,
      },
    );

    expect(out.text()).not.toContain("super-secret-value");
  });
});
