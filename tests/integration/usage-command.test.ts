import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { usageCommand } from "../../src/commands/usage.js";
import { makeTempDir, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

/** The exact shape the real endpoint returned on 2026-09-18 (specs/usage.md). */
const REAL_PAYLOAD = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 2000,
        currentValue: 912,
        remaining: 1087,
        percentage: 45,
        nextResetTime: 1789715562684,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 10000,
        currentValue: 3304,
        remaining: 6695,
        percentage: 33,
        nextResetTime: 1790232766963,
      },
    ],
    level: "lite",
  },
  success: true,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-usage-cmd-");
  dirs.push(dir);
  return dir;
}

function baseDeps(overrides: Partial<Parameters<typeof usageCommand>[1]> = {}) {
  return {
    home: temp(),
    env: { ZAI_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    readUserEnv: () => undefined,
    fetchImpl: (async () => jsonResponse(REAL_PAYLOAD)) as typeof fetch,
    ...overrides,
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

function writeReport(home: string, name: string, report: object): void {
  writeFileSyncAll(path.join(home, ".glm-coding-router", "benchmarks", name), JSON.stringify(report));
}

describe("usageCommand happy path (specs/usage.md)", () => {
  it("renders the real endpoint shape: level, both windows, percentage, reset times", async () => {
    const out = captureStdout();

    const code = await usageCommand({}, baseDeps());

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("Z.AI CODING PLAN  /  lite");
    expect(text).toContain("5-hour window");
    expect(text).toContain("912 / 2000 credits (45%)");
    expect(text).toContain("45% used");
    expect(text).toContain("1087 remaining");
    expect(text).toContain("weekly");
    expect(text).toContain("3304 / 10000 credits (33%)");
    expect(text).toContain("resets 2026-09-18T"); // ISO from nextResetTime 1789715562684
    expect(text).toContain("not available — Claude Code exposes no headless usage API");
    expect(text).toContain("not available — Codex exposes no plan-usage API");
    expect(text).toContain("(none yet");
    expect(text).not.toContain("test-key");
  });

  it("labels unknown enum values generically", async () => {
    const payload = {
      ...REAL_PAYLOAD,
      data: {
        level: "pro",
        limits: [{ type: "CREDIT_LIMIT", unit: 9, number: 2, usage: 50, currentValue: 10, percentage: 20 }],
      },
    };
    const out = captureStdout();

    const code = await usageCommand({}, baseDeps({ fetchImpl: (async () => jsonResponse(payload)) as typeof fetch }));

    expect(code).toBe(0);
    expect(out.text()).toContain("window unit=9 x 2");
    expect(out.text()).toContain("10 / 50 credits (20%)");
  });

  it("computes percentage when the server omits it", async () => {
    const payload = {
      ...REAL_PAYLOAD,
      data: {
        level: "lite",
        limits: [
          { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 400, currentValue: 100, nextResetTime: 1789715562684 },
        ],
      },
    };
    const out = captureStdout();

    await usageCommand({}, baseDeps({ fetchImpl: (async () => jsonResponse(payload)) as typeof fetch }));

    expect(out.text()).toContain("100 / 400 credits (25%)");
  });

  it("--json mirrors the text content and never the key", async () => {
    const out = captureStdout();

    const code = await usageCommand({ json: true }, baseDeps());

    expect(code).toBe(0);
    const text = out.text();
    expect(text).not.toContain("test-key");
    const parsed = JSON.parse(text) as {
      zai: { ok: boolean; level: string; limits: { window: string; percentage: number }[] };
      local: { runs: number };
      claude: string;
      codex: string;
    };
    expect(parsed.zai.ok).toBe(true);
    expect(parsed.zai.level).toBe("lite");
    expect(parsed.zai.limits.map((limit) => limit.window)).toEqual(["5-hour window", "weekly"]);
    expect(parsed.local.runs).toBe(0);
    expect(parsed.claude).toContain("not available");
  });
});

describe("usageCommand local aggregation (specs/usage.md)", () => {
  it("sums runs and tokens across saved benchmark reports, newest last", async () => {
    const home = temp();
    writeReport(home, "benchmark-a.json", {
      finishedAt: "2026-09-18T01:00:00.000Z",
      tasks: [{ inputTokens: 2028, outputTokens: 984 }, { inputTokens: 100, outputTokens: 50 }],
    });
    writeReport(home, "benchmark-b.json", {
      finishedAt: "2026-09-18T03:00:00.000Z",
      tasks: [{ inputTokens: 4927, outputTokens: 1206 }],
    });
    writeReport(home, "benchmark-broken.json", "{ not json");
    const out = captureStdout();

    const code = await usageCommand({}, baseDeps({ home }));

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("LOCAL BENCHMARKS");
    expect(text).toContain("Runs");
    expect(text).toContain("3");
    expect(text).toContain("7055 in / 2240 out");
    expect(text).toContain("2026-09-18T03:00:00.000Z");
  });
});

describe("usageCommand failures (specs/usage.md)", () => {
  it("no key → ERROR [10]", async () => {
    await expect(
      usageCommand({}, { home: temp(), env: {} as NodeJS.ProcessEnv, readUserEnv: () => undefined }),
    ).rejects.toMatchObject({ codeName: "ZAI_KEY_MISSING", exitCode: 10 });
  });

  it("network failure renders [FAIL] with the reason and exits 1", async () => {
    const out = captureStdout();
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const code = await usageCommand({}, baseDeps({ fetchImpl: failing }));

    expect(code).toBe(1);
    expect(out.text()).toContain("[FAIL]");
    expect(out.text()).toContain("unreachable");
  });

  it("HTTP error and code !== 200 render [FAIL] and exit 1", async () => {
    const http = captureStdout();
    const codeHttp = await usageCommand(
      {},
      baseDeps({ fetchImpl: (async () => jsonResponse({ code: 200 }, 403)) as typeof fetch }),
    );
    expect(codeHttp).toBe(1);
    expect(http.text()).toContain("HTTP 403");

    const apiCode = captureStdout();
    const codeApi = await usageCommand(
      {},
      baseDeps({ fetchImpl: (async () => jsonResponse({ code: 401, msg: "bad key" })) as typeof fetch }),
    );
    expect(codeApi).toBe(1);
    // The provider's `msg` is never echoed (specs/terminal-ui-doctor.md §D "Security").
    expect(apiCode.text()).not.toContain("bad key");
    expect(apiCode.text()).toContain("code 401");
  });

  it("non-JSON body renders [FAIL] and exits 1", async () => {
    const out = captureStdout();
    const code = await usageCommand(
      {},
      baseDeps({
        fetchImpl: (async () => new Response("<html>gateway</html>", { status: 200 })) as typeof fetch,
      }),
    );

    expect(code).toBe(1);
    expect(out.text()).toContain("non-JSON");
  });
});
