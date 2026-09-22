import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardCommand } from "../../src/commands/dashboard.js";
import { activeRunFile, runDir } from "../../src/core/paths.js";
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

/** A quota with ~7% of the weekly window left — comfortably in "critical". */
const CRITICAL_PAYLOAD = {
  ...REAL_PAYLOAD,
  data: {
    level: "lite",
    limits: [
      REAL_PAYLOAD.data.limits[0],
      { ...REAL_PAYLOAD.data.limits[1], currentValue: 9300, remaining: 700, percentage: 93 },
    ],
  },
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Fixed-width ids that sort like real ULIDs, with distinct tails so short ids
 * are deterministic and unambiguous by construction.
 */
function makeId(tag: string, tail: string): string {
  return `run_${tag}${"0".repeat(20)}${tail}`;
}

const ID_ACTIVE = makeId("01DA", "ACT1");
const ID_ORPHAN = makeId("01DB", "ORPH");
const ID_DONE = makeId("01C8", "DONE");
const ID_FAILED = makeId("01C7", "FAIL");

const FIXED_NOW = "2026-09-20T10:05:00.000Z";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-dash-cmd-");
  dirs.push(dir);
  return dir;
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

interface SeedOptions {
  readonly id: string;
  readonly date: string;
  readonly kind?: "worker" | "review" | "delegate";
  readonly model?: string;
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly heartbeatAt?: string;
  readonly events?: readonly Record<string, unknown>[];
  readonly summary?: Record<string, unknown>;
  readonly active?: { readonly state: string };
}

/** Fabricates a run directory (and optionally its active entry) directly. */
function seedRun(home: string, opts: SeedOptions): string {
  const dir = runDir(home, opts.date, opts.id);
  const events = opts.events ?? [];
  if (events.length > 0) {
    writeFileSyncAll(path.join(dir, "events.jsonl"), events.map((body) => JSON.stringify(body)).join("\n") + "\n");
  }
  if (opts.summary !== undefined) {
    writeFileSyncAll(path.join(dir, "summary.json"), `${JSON.stringify(opts.summary, null, 2)}\n`);
  }
  if (opts.active !== undefined) {
    writeFileSyncAll(
      activeRunFile(home, opts.id),
      `${JSON.stringify(
        {
          id: opts.id,
          kind: opts.kind ?? "worker",
          provider: "zai.zcode",
          role: "worker",
          model: opts.model ?? "glm-5.3",
          cwd: opts.cwd ?? "C:\\work\\repo",
          startedAt: opts.startedAt ?? "2026-09-20T10:00:00.000Z",
          parent: { type: "claude" },
          taskTitle: "Seeded task",
          taskHash: "c".repeat(64),
          pid: 424_242,
          date: opts.date,
          state: opts.active.state,
          heartbeatAt: opts.heartbeatAt ?? new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }
  return dir;
}

function eventLine(id: string, seq: number, body: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: id,
    taskId: id,
    provider: "zai.zcode",
    role: "worker",
    seq,
    ts: `2026-09-20T10:00:${String(10 + seq).padStart(2, "0")}.000Z`,
    ...body,
  };
}

/** A seeded world: one live run, one orphaned run, one completed and one failed history run. */
function seedWorld(home: string): void {
  const date = "2026-09-20";
  seedRun(home, {
    id: ID_ACTIVE,
    date,
    cwd: "C:\\work\\repo-live",
    startedAt: "2026-09-20T10:00:00.000Z",
    events: [
      eventLine(ID_ACTIVE, 1, { type: "RunStarted", kind: "worker", model: "glm-5.3", cwd: "C:\\work\\repo-live", taskTitle: "Live task", taskHash: "a".repeat(64), parent: { type: "claude" } }),
      eventLine(ID_ACTIVE, 2, { type: "TurnStarted", turn: 1 }),
    ],
    active: { state: "RUNNING" },
  });
  seedRun(home, {
    id: ID_ORPHAN,
    date,
    cwd: "C:\\work\\repo-x",
    startedAt: "2026-09-20T09:00:00.000Z",
    events: [
      eventLine(ID_ORPHAN, 1, { type: "RunStarted", kind: "worker", model: "glm-5.3", cwd: "C:\\work\\repo-x", taskTitle: "Died mid-run", taskHash: "b".repeat(64), parent: { type: "shell" } }),
    ],
    // Stale heartbeat + (injected) dead pid = orphaned.
    active: { state: "RUNNING" },
    heartbeatAt: "2020-01-01T00:00:00.000Z",
  });
  seedRun(home, {
    id: ID_DONE,
    date,
    events: [
      eventLine(ID_DONE, 1, { type: "RunStarted", kind: "worker", model: "glm-5.3", cwd: "C:\\work\\repo", taskTitle: "Done task", taskHash: "a".repeat(64), parent: { type: "claude" } }),
    ],
    summary: { id: ID_DONE, state: "COMPLETED", turns: 2, durationMs: 5400, filesChanged: ["src/a.ts"], tokensIn: 1234, tokensOut: 567, denied: 0, retries: 0, validation: "ok" },
  });
  seedRun(home, {
    id: ID_FAILED,
    date,
    events: [
      eventLine(ID_FAILED, 1, { type: "RunStarted", kind: "review", model: "glm-5.3-flash", cwd: "C:\\work\\repo", taskTitle: "Broken task", taskHash: "a".repeat(64), parent: { type: "codex" } }),
      eventLine(ID_FAILED, 2, { type: "RunFailed", reason: "child_error", exitCode: 40 }),
    ],
    summary: { id: ID_FAILED, state: "FAILED", turns: 0, durationMs: 800, filesChanged: [], tokensIn: 0, tokensOut: 0, denied: 1, retries: 0, validation: "none" },
  });
}

/** The deps every test uses: fixed clock, dead-pid probe, no network, no real key store. */
function baseDeps(
  home: string,
  overrides: Partial<NonNullable<Parameters<typeof dashboardCommand>[1]>> = {},
): Parameters<typeof dashboardCommand>[1] {
  return {
    home,
    now: () => new Date(FIXED_NOW),
    isAlive: () => false,
    fetchImpl: (async () => jsonResponse(REAL_PAYLOAD)) as typeof fetch,
    resolveKey: () => ({ key: "test-key", source: "process-env" as const }),
    isTTY: false,
    ...overrides,
  };
}

describe("dashboardCommand (specs/v2-architecture.md Phase G)", () => {
  it("non-TTY prints exactly ONE snapshot: quota numbers, active row, recent row, footer", async () => {
    const home = temp();
    seedWorld(home);
    const out = captureStdout();
    let fetches = 0;
    const deps = baseDeps(home, {
      fetchImpl: (async () => {
        fetches += 1;
        return jsonResponse(REAL_PAYLOAD);
      }) as typeof fetch,
    });

    const code = await dashboardCommand({}, deps);

    expect(code).toBe(0);
    const text = out.text();
    // Quota from the injected fetch, both windows, zone word from remaining ratio.
    expect(text).toContain("5-hour window");
    expect(text).toContain("912 / 2000 credits (45%)");
    expect(text).toContain("3304 / 10000 credits (33%)");
    expect(text).toContain("ok");
    // Active run row: short id, state, model, elapsed, cwd basename.
    expect(text).toContain("RUNNING");
    expect(text).toContain("repo-live");
    // Elapsed from the fixed clock: 10:05:00 - 10:00:00.
    expect(text).toContain("5m 00s");
    // Recent run rows: state, duration, turns, files.
    expect(text).toContain("COMPLETED");
    expect(text).toContain("5.4s");
    expect(text).toContain("2 turns");
    expect(text).toContain("1 file");
    // Footer with the configured main model.
    expect(text).toContain("glm-5.3");
    // Exactly one snapshot — the sections appear once each.
    expect(text.split("Quota").length - 1).toBe(1);
    expect(text.split("Active Runs").length - 1).toBe(1);
    // Piped output must be byte-clean: no escape codes at all.
    expect(text).not.toContain("\u001b");
    // One snapshot means one fetch.
    expect(fetches).toBe(1);
  });

  it("the zone word follows the remaining ratio: critical at <= 15%", async () => {
    const home = temp();
    const out = captureStdout();

    const code = await dashboardCommand({}, baseDeps(home, { fetchImpl: (async () => jsonResponse(CRITICAL_PAYLOAD)) as typeof fetch }));

    expect(code).toBe(0);
    const text = out.text();
    // The overall verdict comes from the worst window (weekly at 7%).
    expect(text).toContain("— critical");
    // The healthy 5-hour window still reports its own zone word.
    expect(text).toContain("credits (45%) · ok");
  });

  it("--json emits valid JSON with quota, active[] and recent[] keys", async () => {
    const home = temp();
    seedWorld(home);
    const out = captureStdout();

    const code = await dashboardCommand({ json: true }, baseDeps(home));

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text()) as {
      model: string;
      quota: {
        ok: boolean;
        level: string | null;
        zone: string;
        windows: { window: string; used: number | null; limit: number | null; resetsAt: string | null }[];
      };
      active: { id: string; state: string; orphaned: boolean }[];
      recent: { id: string; state: string; turns: number | null; files: number | null }[];
      errors: { id: string; state: string; reason: string | null }[];
    };
    expect(parsed.model).toBe("glm-5.3");
    expect(parsed.quota.ok).toBe(true);
    expect(parsed.quota.level).toBe("lite");
    expect(parsed.quota.zone).toBe("ok");
    expect(parsed.quota.windows.map((window) => window.window)).toEqual(["5-hour window", "weekly"]);
    expect(parsed.quota.windows[0].used).toBe(912);
    expect(parsed.quota.windows[0].resetsAt).toBe(new Date(1789715562684).toISOString());
    // Both listings are newest-first by ULID: 01DB > 01DA, 01C8 > 01C7.
    expect(parsed.active.map((row) => row.id)).toEqual([ID_ORPHAN, ID_ACTIVE]);
    expect(parsed.active[0].orphaned).toBe(true);
    expect(parsed.active[1].orphaned).toBe(false);
    expect(parsed.recent.map((row) => row.id)).toEqual([ID_DONE, ID_FAILED]);
    expect(parsed.recent[0].turns).toBe(2);
    expect(parsed.recent[0].files).toBe(1);
    expect(parsed.errors).toEqual([{ id: ID_FAILED, state: "FAILED", reason: "child_error" }]);
  });

  it("a throwing fetch renders 'quota unavailable', still exits 0 and still renders runs", async () => {
    const home = temp();
    seedWorld(home);
    const out = captureStdout();

    const code = await dashboardCommand(
      {},
      baseDeps(home, { fetchImpl: (async () => { throw new Error("boom"); }) as typeof fetch }),
    );

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("quota unavailable");
    expect(text).toContain("Z.ai monitor endpoint was unreachable");
    expect(text).toContain("repo-live");
    expect(text).toContain("COMPLETED");
  });

  it("no key takes the same graceful path", async () => {
    const home = temp();
    seedWorld(home);
    const out = captureStdout();

    const code = await dashboardCommand({}, baseDeps(home, { resolveKey: () => undefined }));

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("quota unavailable");
    expect(text).toContain("no Z.ai API key configured");
    expect(text).toContain("Active Runs");
    expect(text).toContain("Recent Runs");
  });

  it("marks an orphaned active run and keeps a live one unmarked", async () => {
    const home = temp();
    seedWorld(home);
    const out = captureStdout();

    const code = await dashboardCommand({}, baseDeps(home));

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("repo-x (orphaned)");
    expect(text).toContain("repo-live");
    // The live run is listed without the marker.
    const liveLine = text.split("\n").find((line) => line.includes("repo-live"));
    expect(liveLine).toBeDefined();
    expect(liveLine).not.toContain("orphaned");
  });

  it("an empty registry renders placeholder sections, not a broken frame", async () => {
    const home = temp();
    const out = captureStdout();

    const code = await dashboardCommand({}, baseDeps(home));

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("(none)");
    expect(text).toContain("Model  glm-5.3");
  });

  it("a non-positive --interval is INVALID_ARGS", async () => {
    const error = await dashboardCommand({ interval: 0 }, baseDeps(temp())).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ codeName: "INVALID_ARGS" });
  });
});
