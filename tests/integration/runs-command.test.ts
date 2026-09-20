import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runsCleanCommand, runsCommand, runsLogsCommand, runsShowCommand } from "../../src/commands/runs.js";
import { activeRunFile, runDir } from "../../src/core/paths.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fixed-width ids that sort like real ULIDs, with distinct tails so short ids
 * and suffix matching are deterministic and unambiguous by construction.
 */
function makeId(tag: string, tail: string): string {
  return `run_${tag}${"0".repeat(20)}${tail}`;
}

const ID_A = makeId("01AA", "AA"); // completed
const ID_B = makeId("01AB", "BB"); // failed
const ID_C = makeId("01AC", "CC"); // crashed (events, no summary)
const ID_AMBIG_1 = makeId("01BA", "XY");
const ID_AMBIG_2 = makeId("01BB", "XY");

const CWD_A = "C:\\work\\repo-a";
const TITLE_A = "Fix the login bug";

/** The list table's column headers, mirrored so a renamed column fails a test. */
const TABLE_HEADERS = ["id", "state", "kind", "model", "started", "duration", "turns", "files", "cwd"];

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-runs-cmd-");
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

function captureStderr(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

/** Runs fn and returns what it threw, so sync command errors assert cleanly. */
function catchFrom(fn: () => number): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

interface SeedOptions {
  readonly id: string;
  readonly date: string;
  readonly kind?: "worker" | "review" | "delegate";
  readonly model?: string;
  readonly cwd?: string;
  readonly taskTitle?: string;
  readonly startedAt?: string;
  readonly pid?: number;
  readonly events?: readonly Record<string, unknown>[];
  readonly summary?: Record<string, unknown>;
  readonly active?: { readonly state: string; readonly heartbeatAt: string };
  readonly checkpoint?: boolean;
}

/** Fabricates a run directory (and optionally its active entry) directly — faster and more honest than driving real workers. */
function seedRun(home: string, opts: SeedOptions): string {
  const dir = runDir(home, opts.date, opts.id);
  const events = opts.events ?? [];
  if (events.length > 0) {
    const lines = events.map((body, index) =>
      JSON.stringify({
        runId: opts.id,
        taskId: opts.id,
        provider: "zai.zcode",
        role: "worker",
        seq: index + 1,
        ts: `2026-09-20T10:00:${String(10 + index).padStart(2, "0")}.000Z`,
        ...body,
      }),
    );
    writeFileSyncAll(path.join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
  }
  if (opts.summary !== undefined) {
    writeFileSyncAll(path.join(dir, "summary.json"), `${JSON.stringify(opts.summary, null, 2)}\n`);
  }
  if (opts.checkpoint === true) {
    writeFileSyncAll(path.join(dir, "checkpoint.json"), '{\n  "phase": "implementation"\n}\n');
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
          taskTitle: opts.taskTitle ?? "Seeded task",
          taskHash: "c".repeat(64),
          pid: opts.pid ?? 424_242,
          date: opts.date,
          state: opts.active.state,
          heartbeatAt: opts.active.heartbeatAt,
        },
        null,
        2,
      )}\n`,
    );
  }
  return dir;
}

function completedEvents(cwd: string, title: string): Record<string, unknown>[] {
  return [
    { type: "RunStarted", kind: "worker", model: "glm-5.3", cwd, taskTitle: title, taskHash: "a".repeat(64), parent: { type: "claude" } },
    { type: "TurnStarted", turn: 1 },
    { type: "ToolStarted", turn: 1, toolUseId: "tu1", tool: "Read", summary: "src/a.ts" },
    { type: "ToolCompleted", turn: 1, toolUseId: "tu1", tool: "Read", ok: true, durationMs: 120 },
    { type: "ValidationStarted", turn: 1, command: "npm test" },
    { type: "ToolStarted", turn: 1, toolUseId: "tu2", tool: "Bash", summary: "npm test" },
    { type: "ValidationCompleted", turn: 1, command: "npm test", ok: true, durationMs: 3000 },
    { type: "FileChanged", turn: 1, path: "src/a.ts", op: "edit" },
    { type: "TurnStarted", turn: 2 },
    { type: "ToolStarted", turn: 2, toolUseId: "tu3", tool: "Edit", summary: "src/a.ts" },
    { type: "RunCompleted", turns: 2, durationMs: 5400, filesChanged: 1, tokensIn: 1234, tokensOut: 567 },
  ];
}

function failedEvents(cwd: string, title: string): Record<string, unknown>[] {
  return [
    { type: "RunStarted", kind: "review", model: "glm-5.3-flash", cwd, taskTitle: title, taskHash: "a".repeat(64), parent: { type: "codex" } },
    { type: "TurnStarted", turn: 1 },
    { type: "ToolStarted", turn: 1, toolUseId: "tu1", tool: "Bash", summary: "npm test" },
    { type: "ToolDenied", turn: 1, toolUseId: "tu1", tool: "Bash", reason: "This command requires approval" },
    { type: "RunFailed", reason: "child_error", exitCode: 40 },
  ];
}

/** A killed process: everything but a terminal event, and no summary.json. */
function crashedEvents(cwd: string, title: string): Record<string, unknown>[] {
  return [
    { type: "RunStarted", kind: "worker", model: "glm-5.3", cwd, taskTitle: title, taskHash: "b".repeat(64), parent: { type: "shell" } },
    { type: "TurnStarted", turn: 1 },
    { type: "ToolStarted", turn: 1, toolUseId: "tu1", tool: "Read", summary: "src/a.ts" },
    { type: "TurnStarted", turn: 2 },
    { type: "ToolStarted", turn: 2, toolUseId: "tu2", tool: "Edit", summary: "src/a.ts" },
    { type: "FileChanged", turn: 2, path: "src/a.ts", op: "edit" },
  ];
}

function summaryOf(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    state: "COMPLETED",
    turns: 2,
    durationMs: 5400,
    filesChanged: ["src/a.ts"],
    tokensIn: 1234,
    tokensOut: 567,
    denied: 0,
    retries: 0,
    validation: "ok",
    ...overrides,
  };
}

function collectRelativeFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return files.sort();
}

const DATE = "2026-09-20";
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
const today = (): string => new Date().toISOString().slice(0, 10);

describe("runsCommand listing (specs/v2-architecture.md Phase G)", () => {
  it("an empty history prints one clear line and exits 0 — no history is normal", () => {
    const out = captureStdout();

    const code = runsCommand({}, { home: temp() });

    expect(code).toBe(0);
    expect(out.text()).toContain("no runs recorded yet");
  });

  it("lists history newest-first with short ids, states and cwd basenames", () => {
    const home = temp();
    seedRun(home, { id: ID_A, date: DATE, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A) });
    seedRun(home, { id: ID_B, date: DATE, cwd: "C:\\work\\repo-b", taskTitle: "Review the PR", events: failedEvents("C:\\work\\repo-b", "Review the PR"), summary: summaryOf(ID_B, { state: "FAILED", denied: 1 }) });
    seedRun(home, { id: ID_C, date: DATE, cwd: "C:\\work\\repo-c", taskTitle: "Crashed mid-edit", events: crashedEvents("C:\\work\\repo-c", "Crashed mid-edit") });
    const out = captureStdout();

    const code = runsCommand({}, { home });

    expect(code).toBe(0);
    const text = out.text();
    for (const header of TABLE_HEADERS) {
      expect(text).toContain(header);
    }
    expect(text).toContain("0000AA");
    expect(text).toContain("COMPLETED");
    expect(text).toContain("0000BB");
    expect(text).toContain("FAILED");
    expect(text).toContain("0000CC");
    expect(text).toContain("CRASHED");
    // Newest-first: C's short id appears above A's.
    expect(text.indexOf("0000CC")).toBeLessThan(text.indexOf("0000AA"));
    // The table shortens ids and cwds — full values must not leak into it.
    expect(text).not.toContain(ID_A);
    expect(text).not.toContain("C:\\work");
    expect(text).toContain("repo-a");
  });

  it("--limit keeps only the newest runs", () => {
    const home = temp();
    seedRun(home, { id: ID_A, date: DATE, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A) });
    seedRun(home, { id: ID_B, date: DATE, cwd: "C:\\work\\repo-b", taskTitle: "Review the PR", events: failedEvents("C:\\work\\repo-b", "Review the PR"), summary: summaryOf(ID_B, { state: "FAILED" }) });
    seedRun(home, { id: ID_C, date: DATE, cwd: "C:\\work\\repo-c", taskTitle: "Crashed mid-edit", events: crashedEvents("C:\\work\\repo-c", "Crashed mid-edit") });
    const out = captureStdout();

    const code = runsCommand({ limit: 1 }, { home });

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("0000CC");
    expect(text).not.toContain("0000AA");
    expect(text).not.toContain("0000BB");
  });

  it("--active lists only the active registry, state from the active file", () => {
    const home = temp();
    seedRun(home, { id: ID_A, date: DATE, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A) });
    const activeOne = makeId("01DA", "D1");
    const activeTwo = makeId("01DB", "D2");
    seedRun(home, {
      id: activeOne,
      date: DATE,
      cwd: "C:\\work\\repo-live",
      startedAt: "2026-09-20T10:00:00.000Z",
      events: crashedEvents("C:\\work\\repo-live", "Still going"),
      active: { state: "RUNNING", heartbeatAt: "2026-09-20T10:00:25.000Z" },
    });
    seedRun(home, {
      id: activeTwo,
      date: DATE,
      startedAt: "2026-09-20T10:00:00.000Z",
      active: { state: "VERIFYING", heartbeatAt: "2026-09-20T10:00:25.000Z" },
    });
    const out = captureStdout();

    const code = runsCommand(
      { active: true },
      { home, now: () => new Date("2026-09-20T10:00:30.000Z") },
    );

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("0000D1");
    expect(text).toContain("RUNNING");
    expect(text).toContain("0000D2");
    expect(text).toContain("VERIFYING");
    expect(text).not.toContain("0000AA");
    // Live duration comes from the injected clock: 10:00:30 - 10:00:00.
    expect(text).toContain("30.0s");
  });

  it("--json carries FULL ids and FULL cwd paths", () => {
    const home = temp();
    seedRun(home, { id: ID_A, date: DATE, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A) });
    seedRun(home, { id: ID_C, date: DATE, cwd: "C:\\work\\repo-c", taskTitle: "Crashed mid-edit", events: crashedEvents("C:\\work\\repo-c", "Crashed mid-edit") });
    const out = captureStdout();

    const code = runsCommand({ json: true }, { home });

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text()) as {
      id: string;
      state: string;
      kind: string | null;
      model: string | null;
      cwd: string | null;
      turns: number | null;
      files: number | null;
      durationMs: number | null;
    }[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((row) => row.id)).toEqual([ID_C, ID_A]);
    const rowA = parsed.find((row) => row.id === ID_A);
    expect(rowA?.cwd).toBe(CWD_A);
    expect(rowA?.turns).toBe(2);
    expect(rowA?.files).toBe(1);
    expect(rowA?.model).toBe("glm-5.3");
    const rowC = parsed.find((row) => row.id === ID_C);
    expect(rowC?.state).toBe("CRASHED");
    expect(rowC?.durationMs).toBeNull();
  });

  it("a non-positive --limit is INVALID_ARGS", () => {
    const error = catchFrom(() => runsCommand({ limit: 0 }, { home: temp() }));
    expect(error).toMatchObject({ codeName: "INVALID_ARGS" });
  });
});

describe("runsShowCommand (specs/v2-architecture.md Phase G)", () => {
  it("renders metadata, summary numbers and the per-turn tree by full id", () => {
    const home = temp();
    seedRun(home, { id: ID_A, date: DATE, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A) });
    const out = captureStdout();

    const code = runsShowCommand(ID_A, {}, { home });

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain(ID_A);
    expect(text).toContain(TITLE_A);
    expect(text).toContain("worker (role: worker)");
    expect(text).toContain("COMPLETED");
    expect(text).toContain("glm-5.3");
    expect(text).toContain("zai.zcode");
    expect(text).toContain(CWD_A);
    expect(text).toContain("5.4s");
    expect(text).toContain("Turns");
    expect(text).toContain("2");
    expect(text).toContain("Files changed");
    expect(text).toContain("Tokens in");
    expect(text).toContain("1234");
    expect(text).toContain("Validation");
    expect(text).toContain("ok");
    // The tree matches the live progress renderer's shape.
    expect(text).toContain("◉ Turn 1");
    expect(text).toContain("◉ Turn 2");
    expect(text).toContain("├─ Read");
    expect(text).toContain("└─ Edit");
    expect(text).toContain("npm test");
    expect(text).toContain("✓ tests passed");
    expect(text).toContain("✓ Completed");
    // Phase F has not landed: no checkpoint line for a checkpoint-less run.
    expect(text).not.toContain("Checkpoint");
  });

  it("accepts the short id pasted from the table", () => {
    const home = temp();
    seedRun(home, { id: ID_A, date: DATE, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A) });
    const out = captureStdout();

    const code = runsShowCommand("0000AA", {}, { home });

    expect(code).toBe(0);
    expect(out.text()).toContain(TITLE_A);
  });

  it("an ambiguous suffix is INVALID_ARGS and names every candidate", () => {
    const home = temp();
    seedRun(home, { id: ID_AMBIG_1, date: DATE, cwd: CWD_A, taskTitle: "One", events: crashedEvents(CWD_A, "One") });
    seedRun(home, { id: ID_AMBIG_2, date: DATE, cwd: CWD_A, taskTitle: "Two", events: crashedEvents(CWD_A, "Two") });

    const error = catchFrom(() => runsShowCommand("XY", {}, { home }));

    expect(error).toMatchObject({ codeName: "INVALID_ARGS" });
    const listed = (error as { hint: readonly string[] }).hint.join("\n");
    expect(listed).toContain(ID_AMBIG_1);
    expect(listed).toContain(ID_AMBIG_2);
  });

  it("an unknown id is INVALID_ARGS naming the id", () => {
    const error = catchFrom(() => runsShowCommand("run_nope", {}, { home: temp() }));

    expect(error).toMatchObject({ codeName: "INVALID_ARGS" });
    expect((error as Error).message).toContain("run_nope");
  });

  it("a crashed run (events but no summary.json) still renders with rebuilt numbers", () => {
    const home = temp();
    seedRun(home, { id: ID_C, date: DATE, cwd: "C:\\work\\repo-c", taskTitle: "Crashed mid-edit", events: crashedEvents("C:\\work\\repo-c", "Crashed mid-edit") });
    const out = captureStdout();

    const code = runsShowCommand(ID_C, {}, { home });

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("CRASHED");
    expect(text).toContain("✗ Crashed");
    // Rebuilt from events: 2 turns, 1 file, span 10:00:10 → 10:00:15.
    expect(text).toContain("5.0s");
    expect(text).toContain("Files changed");
    expect(text).toContain("1");
  });

  it("a checkpoint.json gets a pointer line", () => {
    const home = temp();
    const dir = seedRun(home, { id: ID_A, date: DATE, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A), checkpoint: true });
    const out = captureStdout();

    const code = runsShowCommand(ID_A, {}, { home });

    expect(code).toBe(0);
    expect(out.text()).toContain("Checkpoint");
    expect(out.text()).toContain(path.join(dir, "checkpoint.json"));
  });

  it("--json carries metadata, the full summary and the tree", () => {
    const home = temp();
    seedRun(home, { id: ID_A, date: DATE, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A) });
    const out = captureStdout();

    const code = runsShowCommand(ID_A, { json: true }, { home });

    expect(code).toBe(0);
    const parsed = JSON.parse(out.text()) as {
      id: string;
      state: string;
      cwd: string;
      taskTitle: string;
      checkpoint: string | null;
      summary: { turns: number; filesChanged: string[]; validation: string };
      turns: { turn: number; entries: string[] }[];
    };
    expect(parsed.id).toBe(ID_A);
    expect(parsed.state).toBe("COMPLETED");
    expect(parsed.cwd).toBe(CWD_A);
    expect(parsed.taskTitle).toBe(TITLE_A);
    expect(parsed.checkpoint).toBeNull();
    expect(parsed.summary.turns).toBe(2);
    expect(parsed.summary.filesChanged).toEqual(["src/a.ts"]);
    expect(parsed.summary.validation).toBe("ok");
    expect(parsed.turns.map((block) => block.turn)).toEqual([1, 2]);
    expect(parsed.turns[0].entries.some((entry) => entry.includes("npm test"))).toBe(true);
  });
});

describe("runsLogsCommand (specs/v2-architecture.md Phase G)", () => {
  it("renders one line per event with seq, ts, type and details", () => {
    const home = temp();
    seedRun(home, { id: ID_A, date: DATE, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A) });
    const out = captureStdout();

    const code = runsLogsCommand(ID_A, {}, { home });

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("2026-09-20T10:00:10.000Z");
    expect(text).toContain("RunStarted");
    expect(text).toContain("kind=worker");
    expect(text).toContain(`task=${JSON.stringify(TITLE_A)}`);
    expect(text).toContain("ToolStarted");
    expect(text).toContain('summary="src/a.ts"');
    expect(text).toContain("RunCompleted");
    expect(text).toContain("tokensIn=1234");
  });

  it("--json prints the raw lines so each parses as one JSON object", () => {
    const home = temp();
    seedRun(home, { id: ID_A, date: DATE, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A) });
    const out = captureStdout();

    const code = runsLogsCommand(ID_A, { json: true }, { home });

    expect(code).toBe(0);
    const lines = out.text().trim().split(/\r?\n/);
    const parsed = lines.map((line) => JSON.parse(line) as { type: string; seq: number });
    expect(parsed).toHaveLength(11);
    expect(parsed[0]).toMatchObject({ type: "RunStarted", seq: 1 });
    expect(parsed[parsed.length - 1]).toMatchObject({ type: "RunCompleted", seq: 11 });
  });

  it("a missing events.jsonl is an error naming the run", () => {
    const home = temp();
    // Summary only — no events file to read.
    seedRun(home, { id: ID_B, date: DATE, summary: summaryOf(ID_B, { state: "FAILED" }) });
    const err = captureStderr();

    const code = runsLogsCommand(ID_B, {}, { home });

    expect(code).toBe(1);
    expect(err.text()).toContain(ID_B);
    expect(err.text()).toContain("events.jsonl");
  });
});

describe("runsCleanCommand (specs/v2-architecture.md Phase G)", () => {
  it("--older-than prunes history past the cutoff and keeps recent runs", () => {
    const home = temp();
    const oldDate = daysAgo(40);
    const oldDir = seedRun(home, { id: ID_A, date: oldDate, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A) });
    const recentDir = seedRun(home, { id: ID_B, date: today(), cwd: "C:\\work\\repo-b", taskTitle: "Recent", events: failedEvents("C:\\work\\repo-b", "Recent"), summary: summaryOf(ID_B, { state: "FAILED" }) });
    const out = captureStdout();

    const code = runsCleanCommand({ olderThan: "30d" }, { home });

    expect(code).toBe(0);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(recentDir)).toBe(true);
    expect(out.text()).toContain("removed 1 run");
  });

  it("enforces history.maxRuns from the config, oldest first", () => {
    const home = temp();
    writeFileSyncAll(
      path.join(home, ".glm-coding-router", "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        provider: { name: "zai", anthropicBaseUrl: "https://api.z.ai/api/anthropic" },
        models: { main: "glm-5.3", fast: "glm-5.3-flash" },
        history: { retentionDays: 3650, maxRuns: 2 },
      }),
    );
    const date = today();
    const ids = [makeId("02A1", "01"), makeId("02A2", "02"), makeId("02A3", "03"), makeId("02A4", "04")];
    for (const id of ids) {
      seedRun(home, { id, date, events: crashedEvents(CWD_A, "filler"), });
    }
    const out = captureStdout();

    const code = runsCleanCommand({}, { home });

    expect(code).toBe(0);
    expect(fs.existsSync(runDir(home, date, ids[0]))).toBe(false);
    expect(fs.existsSync(runDir(home, date, ids[1]))).toBe(false);
    expect(fs.existsSync(runDir(home, date, ids[2]))).toBe(true);
    expect(fs.existsSync(runDir(home, date, ids[3]))).toBe(true);
    expect(out.text()).toContain("removed 2 runs");
  });

  it("--orphans reaps a stale-heartbeat run with an injected dead pid, as FAILED", () => {
    const home = temp();
    const orphanId = makeId("03AA", "OR");
    seedRun(home, {
      id: orphanId,
      date: today(),
      cwd: "C:\\work\\repo-x",
      taskTitle: "Died mid-run",
      events: crashedEvents("C:\\work\\repo-x", "Died mid-run"),
      active: { state: "RUNNING", heartbeatAt: "2020-01-01T00:00:00.000Z" },
    });
    const out = captureStdout();

    const code = runsCleanCommand({ orphans: true }, { home, isAlive: () => false });

    expect(code).toBe(0);
    expect(fs.existsSync(activeRunFile(home, orphanId))).toBe(false);
    const summary = JSON.parse(readText(path.join(runDir(home, today(), orphanId), "summary.json"))) as {
      state: string;
      turns: number;
    };
    expect(summary.state).toBe("FAILED");
    expect(summary.turns).toBe(2); // rebuilt from events.jsonl
    expect(out.text()).toContain("reaped 1 orphan");
    // No --older-than given and no age prune requested beyond the config
    // default — the run is one day old, so nothing else is removed.
    expect(out.text()).toContain("removed 0 runs");
  });

  it("--orphans does NOT reap a run whose pid is alive", () => {
    const home = temp();
    const liveId = makeId("03AB", "LV");
    seedRun(home, {
      id: liveId,
      date: today(),
      events: crashedEvents(CWD_A, "Busy, not dead"),
      active: { state: "RUNNING", heartbeatAt: "2020-01-01T00:00:00.000Z" },
    });
    const out = captureStdout();

    const code = runsCleanCommand({ orphans: true }, { home, isAlive: () => true });

    expect(code).toBe(0);
    expect(fs.existsSync(activeRunFile(home, liveId))).toBe(true);
    expect(out.text()).toContain("reaped 0 orphans");
  });

  it("--dry-run prints the plan and leaves every file in place", () => {
    const home = temp();
    seedRun(home, { id: ID_A, date: daysAgo(40), events: crashedEvents(CWD_A, "old"), });
    const orphanId = makeId("03AC", "OR");
    seedRun(home, {
      id: orphanId,
      date: today(),
      events: crashedEvents(CWD_A, "orphan"),
      active: { state: "RUNNING", heartbeatAt: "2020-01-01T00:00:00.000Z" },
    });
    const before = collectRelativeFiles(home);
    const out = captureStdout();

    const code = runsCleanCommand(
      { olderThan: "30d", orphans: true, dryRun: true },
      { home, isAlive: () => false },
    );

    expect(code).toBe(0);
    expect(collectRelativeFiles(home)).toEqual(before);
    const text = out.text();
    expect(text).toContain("would remove 1 run");
    expect(text).toContain("would reap 1 orphan");
    expect(text).toContain("dry run");
    // And the plan names what it would touch.
    expect(text).toContain(ID_A);
    expect(text).toContain(orphanId);
  });

  it("an unparseable --older-than is INVALID_ARGS", () => {
    const error = catchFrom(() => runsCleanCommand({ olderThan: "soon" }, { home: temp() }));
    expect(error).toMatchObject({ codeName: "INVALID_ARGS" });
  });
});

describe("runs commands never write outside their contract", () => {
  it("list, show and logs leave the fabricated tree byte-identical", () => {
    const home = temp();
    seedRun(home, { id: ID_A, date: DATE, cwd: CWD_A, taskTitle: TITLE_A, events: completedEvents(CWD_A, TITLE_A), summary: summaryOf(ID_A) });
    const before = collectRelativeFiles(home);
    captureStdout();

    expect(runsCommand({}, { home })).toBe(0);
    expect(runsCommand({ json: true }, { home })).toBe(0);
    expect(runsShowCommand(ID_A, {}, { home })).toBe(0);
    expect(runsLogsCommand(ID_A, {}, { home })).toBe(0);

    expect(collectRelativeFiles(home)).toEqual(before);
  });
});



