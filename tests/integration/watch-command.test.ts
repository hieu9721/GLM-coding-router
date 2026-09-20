import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchCommand } from "../../src/commands/watch.js";
import { activeRunFile, runDir } from "../../src/core/paths.js";
import { makeTempDir, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

/**
 * Fixed-width ids that sort like real ULIDs, with distinct tails so suffix
 * matching is deterministic and unambiguous by construction.
 */
function makeId(tag: string, tail: string): string {
  return `run_${tag}${"0".repeat(20)}${tail}`;
}

const ID_LIVE = makeId("01CA", "FEED");
const ID_OLD = makeId("01C9", "OLD1");
const ID_DONE = makeId("01C8", "DONE");

/** A watch stand-in that never fires: the injected interval drives every pump. */
const NOOP_WATCH = (): { close(): void } => ({ close(): void {} });

/**
 * A real Node writable that collects bytes instead of emitting them — the
 * injected stand-in for the renderer's stderr.
 */
class MemoryStream extends Writable {
  private readonly parts: string[] = [];

  public constructor() {
    super({
      write: (chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void => {
        this.parts.push(String(chunk));
        callback();
      },
    });
  }

  public text(): string {
    return this.parts.join("");
  }
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

/** Fabricates a run directory directly — faster and more honest than driving real workers. */
function seedRun(home: string, opts: SeedOptions): string {
  const dir = runDir(home, opts.date, opts.id);
  fs.mkdirSync(dir, { recursive: true });
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

/** One canonical event line, envelope included, exactly as the store appends it. */
function eventLine(id: string, seq: number, body: Record<string, unknown>): string {
  return (
    JSON.stringify({
      runId: id,
      taskId: id,
      provider: "zai.zcode",
      role: "worker",
      seq,
      ts: "2026-09-20T10:00:30.000Z",
      ...body,
    }) + "\n"
  );
}

function appendLine(dir: string, line: string): void {
  fs.appendFileSync(path.join(dir, "events.jsonl"), line, "utf8");
}

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-watch-cmd-");
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

/** Runs fn and returns what it threw, so sync resolution errors assert cleanly. */
function catchFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** The deps every following test uses: memory render target, tiny interval, no fs.watch. */
function followDeps(home: string, stderr: MemoryStream): Parameters<typeof watchCommand>[1] {
  return { home, stderr, intervalMs: 20, watchImpl: NOOP_WATCH };
}

describe("watchCommand (specs/v2-architecture.md Phase G)", () => {
  it("no active run → one clear line, exit 0, no hang (the sync path cannot pend)", async () => {
    const out = captureStdout();

    const code = await watchCommand({}, { home: temp() });

    expect(code).toBe(0);
    expect(out.text()).toContain("no active run");
  });

  it("renders events appended AFTER attaching and returns once RunCompleted is appended", async () => {
    const home = temp();
    const dir = seedRun(home, {
      id: ID_LIVE,
      date: today(),
      events: [JSON.parse(eventLine(ID_LIVE, 1, { type: "RunStarted", kind: "worker", model: "glm-5.3", cwd: "C:\\work\\repo", taskTitle: "T", taskHash: "a".repeat(64), parent: { type: "claude" } }))],
      active: { state: "RUNNING" },
    });
    const out = captureStdout();
    const stderr = new MemoryStream();

    // Setup is synchronous, so the follow is armed before anything is appended.
    const pending = watchCommand({}, followDeps(home, stderr));
    appendLine(dir, eventLine(ID_LIVE, 2, { type: "TurnStarted", turn: 1 }));
    appendLine(dir, eventLine(ID_LIVE, 3, { type: "ToolStarted", turn: 1, toolUseId: "tu1", tool: "Edit", summary: "src/a.ts" }));
    appendLine(dir, eventLine(ID_LIVE, 4, { type: "RunCompleted", turns: 1, durationMs: 4321, filesChanged: 1, tokensIn: 10, tokensOut: 5 }));
    const code = await pending;

    expect(code).toBe(0);
    const text = stderr.text();
    // Rendered through the progress renderer's nested mode, like a live run.
    expect(text).toContain("turn 1");
    expect(text).toContain("editing src/a.ts");
    expect(text).toContain("1 turns");
    // Current-end semantics: the pre-existing RunStarted is NOT replayed.
    expect(text).not.toContain("started");
    expect(out.text()).toBe("");
  });

  it("--from-start also renders the events written before watch attached", async () => {
    const home = temp();
    const dir = seedRun(home, {
      id: ID_LIVE,
      date: today(),
      events: [
        JSON.parse(eventLine(ID_LIVE, 1, { type: "RunStarted", kind: "worker", model: "glm-5.3", cwd: "C:\\work\\repo", taskTitle: "T", taskHash: "a".repeat(64), parent: { type: "claude" } })),
        JSON.parse(eventLine(ID_LIVE, 2, { type: "TurnStarted", turn: 1 })),
        JSON.parse(eventLine(ID_LIVE, 3, { type: "ToolStarted", turn: 1, toolUseId: "tu1", tool: "Read", summary: "src/old.ts" })),
      ],
      active: { state: "RUNNING" },
    });
    const stderr = new MemoryStream();

    const pending = watchCommand({ fromStart: true }, followDeps(home, stderr));
    appendLine(dir, eventLine(ID_LIVE, 4, { type: "RunFailed", reason: "child_error", exitCode: 40 }));
    const code = await pending;

    expect(code).toBe(0);
    const text = stderr.text();
    expect(text).toContain("started • glm-5.3");
    expect(text).toContain("exploring src/old.ts");
    expect(text).toContain("child_error");
  });

  it("with no id, attaches to the NEWEST active run", async () => {
    const home = temp();
    seedRun(home, { id: ID_OLD, date: today(), active: { state: "RUNNING" } });
    const newestDir = seedRun(home, { id: ID_LIVE, date: today(), active: { state: "RUNNING" } });
    const stderr = new MemoryStream();

    const pending = watchCommand({}, followDeps(home, stderr));
    appendLine(newestDir, eventLine(ID_LIVE, 1, { type: "RunCancelled", signal: "SIGINT" }));
    const code = await pending;

    expect(code).toBe(0);
    expect(stderr.text()).toContain("cancelled");
  });

  it("a run id suffix resolves like runs show", async () => {
    const home = temp();
    const dir = seedRun(home, { id: ID_LIVE, date: today(), active: { state: "RUNNING" } });
    const stderr = new MemoryStream();

    const pending = watchCommand({ runId: "FEED" }, followDeps(home, stderr));
    appendLine(dir, eventLine(ID_LIVE, 1, { type: "RunCompleted", turns: 0, durationMs: 10, filesChanged: 0, tokensIn: 0, tokensOut: 0 }));
    const code = await pending;

    expect(code).toBe(0);
    expect(stderr.text()).toContain("✓");
  });

  it("an unknown id is INVALID_ARGS naming the id", () => {
    const error = catchFrom(() => watchCommand({ runId: "run_nope" }, { home: temp() }));

    expect(error).toMatchObject({ codeName: "INVALID_ARGS" });
    expect((error as Error).message).toContain("run_nope");
  });

  it("an id that resolves only to history is reported as finished, not hung on", async () => {
    const home = temp();
    seedRun(home, {
      id: ID_DONE,
      date: today(),
      events: [JSON.parse(eventLine(ID_DONE, 1, { type: "RunStarted", kind: "worker", model: "glm-5.3", cwd: "C:\\work\\repo", taskTitle: "T", taskHash: "a".repeat(64), parent: { type: "shell" } }))],
      summary: { id: ID_DONE, state: "COMPLETED", turns: 1, durationMs: 1000, filesChanged: [], tokensIn: 0, tokensOut: 0, denied: 0, retries: 0, validation: "none" },
    });
    const out = captureStdout();

    const code = await watchCommand({ runId: ID_DONE }, { home });

    expect(code).toBe(0);
    expect(out.text()).toContain("already finished");
  });

  it("an active file whose events already ended (stale registry entry) exits instead of hanging", async () => {
    const home = temp();
    seedRun(home, {
      id: ID_LIVE,
      date: today(),
      events: [
        JSON.parse(eventLine(ID_LIVE, 1, { type: "RunStarted", kind: "worker", model: "glm-5.3", cwd: "C:\\work\\repo", taskTitle: "T", taskHash: "a".repeat(64), parent: { type: "claude" } })),
        JSON.parse(eventLine(ID_LIVE, 2, { type: "RunCompleted", turns: 1, durationMs: 1000, filesChanged: 0, tokensIn: 1, tokensOut: 1 })),
      ],
      // The registry still lists the run — a crash between summary and cleanup.
      active: { state: "RUNNING" },
    });
    const out = captureStdout();
    const stderr = new MemoryStream();

    const code = await watchCommand({}, { home, stderr });

    expect(code).toBe(0);
    expect(out.text()).toContain("already ended");
    expect(stderr.text()).toBe("");
  });

  it("stops when the active file disappears without a terminal event (crashed run)", async () => {
    const home = temp();
    seedRun(home, { id: ID_LIVE, date: today(), active: { state: "RUNNING" } });
    const out = captureStdout();
    const stderr = new MemoryStream();

    const pending = watchCommand({}, followDeps(home, stderr));
    fs.rmSync(activeRunFile(home, ID_LIVE));
    const code = await pending;

    expect(code).toBe(0);
    expect(out.text()).toContain("no longer active");
  });

  it("watching leaves the fabricated tree byte-identical", async () => {
    const home = temp();
    const dir = seedRun(home, { id: ID_LIVE, date: today(), active: { state: "RUNNING" } });
    const before = fs.readdirSync(path.dirname(activeRunFile(home, ID_LIVE))).sort();
    captureStdout();
    const stderr = new MemoryStream();

    const pending = watchCommand({}, followDeps(home, stderr));
    appendLine(dir, eventLine(ID_LIVE, 1, { type: "RunCompleted", turns: 0, durationMs: 5, filesChanged: 0, tokensIn: 0, tokensOut: 0 }));
    const code = await pending;

    expect(code).toBe(0);
    // The active registry entry is watch's read model; it must not be touched.
    expect(fs.readdirSync(path.dirname(activeRunFile(home, ID_LIVE))).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")).toContain("RunCompleted");
  });
});
