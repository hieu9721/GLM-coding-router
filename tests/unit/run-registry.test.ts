import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../src/events/bus.js";
import type { WorkerEvent } from "../../src/events/types.js";
import { activeRunFile, activeRunsDir, runDir, runsDir } from "../../src/core/paths.js";
import { ZAI_API_KEY_ENV } from "../../src/core/zai-key.js";
import { startHeartbeat } from "../../src/runs/heartbeat.js";
import {
  createRun,
  finishRun,
  isOrphaned,
  listActive,
  listHistory,
  pruneHistory,
  taskHashOf,
  taskTitleOf,
  updateRun,
  type ActiveRun,
  type RunMeta,
} from "../../src/runs/registry.js";
import { openRunStore } from "../../src/runs/store.js";
import type { RunSummary } from "../../src/runs/store.js";
import { runId } from "../../src/runs/ulid.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

// Every test gets its own fake home so the suite never touches (or depends
// on) a real ~/.glm-coding-router.
let home: string;

beforeEach(() => {
  home = makeTempDir("glm-registry-test-");
});

afterEach(() => {
  removeTempDir(home);
});

function makeMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: runId(),
    kind: "worker",
    provider: "zai.zcode",
    role: "worker",
    model: "glm-5.3",
    cwd: path.join("repo"),
    startedAt: "2026-09-20T10:00:00.000Z",
    parent: { type: "claude" },
    taskTitle: "Do the thing",
    taskHash: taskHashOf("Do the thing"),
    pid: process.pid,
    date: "2026-09-20",
    ...overrides,
  };
}

function activeWith(heartbeatAt: string, pid = 424_242): ActiveRun {
  return { ...makeMeta({ pid }), state: "RUNNING", heartbeatAt };
}

function makeSummary(id: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    state: "COMPLETED",
    turns: 1,
    durationMs: 1500,
    filesChanged: ["src/a.ts"],
    tokensIn: 10,
    tokensOut: 5,
    denied: 0,
    retries: 0,
    validation: "ok",
    ...overrides,
  };
}

/** Fabricates a history run directory without going through the lifecycle. */
function seedRunDir(date: string, id: string): string {
  const dir = runDir(home, date, id);
  writeFileSyncAll(path.join(dir, "summary.json"), "{}\n");
  return dir;
}

/** Fixed-width numeric ids sort lexicographically, like real ULIDs do. */
function numericId(n: number): string {
  return `run_${String(n).padStart(26, "0")}`;
}

function collectFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

describe("run registry (specs/v2-architecture.md Phase B)", () => {
  it("createRun creates the history dir and active file immediately", () => {
    const meta = makeMeta();
    const now = new Date("2026-09-20T10:00:01.000Z");

    const active = createRun(meta, { home, now: () => now });

    expect(active).toEqual({ ...meta, state: "RUNNING", heartbeatAt: "2026-09-20T10:00:01.000Z" });
    // The run dir exists while the run is still going — that is what lets
    // `watch` attach to a live run.
    expect(fs.existsSync(runDir(home, meta.date, meta.id))).toBe(true);
    expect(fs.existsSync(activeRunsDir(home))).toBe(true);
    expect(JSON.parse(readText(activeRunFile(home, meta.id)))).toEqual(active);
  });

  it("updateRun atomically patches state, then finishRun writes summary.json and reaps the active file", () => {
    const meta = makeMeta();
    createRun(meta, { home });

    const updated = updateRun(home, meta.id, { state: "VERIFYING", heartbeatAt: "2026-09-20T10:00:09.000Z" });
    const file = activeRunFile(home, meta.id);
    expect(updated?.state).toBe("VERIFYING");
    expect(updated?.heartbeatAt).toBe("2026-09-20T10:00:09.000Z");
    expect(JSON.parse(readText(file))).toEqual(updated);

    const summary = makeSummary(meta.id);
    finishRun(home, meta.id, summary);
    const dir = runDir(home, meta.date, meta.id);
    expect(JSON.parse(readText(path.join(dir, "summary.json")))).toEqual(summary);
    // Only the active entry is gone; the history directory itself stays.
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("finishRun still writes the summary when the active file is already gone", () => {
    const meta = makeMeta();
    createRun(meta, { home });
    fs.rmSync(activeRunFile(home, meta.id));

    finishRun(home, meta.id, makeSummary(meta.id));

    expect(fs.existsSync(path.join(runDir(home, meta.date, meta.id), "summary.json"))).toBe(true);
  });

  it("listActive ignores corrupt and non-run files instead of throwing", () => {
    createRun(makeMeta(), { home });
    createRun(makeMeta(), { home });
    writeFileSyncAll(path.join(activeRunsDir(home), "run_corrupt.json"), "{ this is not json");
    writeFileSyncAll(path.join(activeRunsDir(home), "notes.txt"), "not a run at all");

    const active = listActive(home);

    expect(active).toHaveLength(2);
    expect(active.every((run) => run.id.startsWith("run_"))).toBe(true);
  });

  it("isOrphaned requires BOTH a stale heartbeat and a dead pid", () => {
    const fresh = activeWith(new Date().toISOString());
    expect(isOrphaned(fresh, { isAlive: () => false })).toBe(false);

    const stale = activeWith("2020-01-01T00:00:00.000Z");
    expect(isOrphaned(stale, { isAlive: () => true })).toBe(false);
    expect(isOrphaned(stale, { isAlive: () => false })).toBe(true);
  });

  it("pruneHistory removes expired date partitions, then overflow beyond maxRuns, oldest first", () => {
    // Dates relative to the real clock: hardcoded ones would flip from
    // "recent" to "expired" the day after they were written.
    const todayIso = new Date().toISOString().slice(0, 10);
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const old = seedRunDir(oldDate, numericId(1));
    const recent = seedRunDir(todayIso, numericId(9));

    const byDays = pruneHistory(home, { retentionDays: 30, maxRuns: 1000 });
    expect(byDays.removed).toEqual([numericId(1)]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);

    seedRunDir(todayIso, numericId(2));
    seedRunDir(todayIso, numericId(3));
    seedRunDir(todayIso, numericId(4));
    seedRunDir(todayIso, numericId(5));

    const byCount = pruneHistory(home, { retentionDays: 3650, maxRuns: 2 });
    // Five runs, cap two: the two newest survive, removals report oldest first.
    expect(byCount.removed).toEqual([numericId(2), numericId(3), numericId(4)]);
    expect(fs.existsSync(runDir(home, todayIso, numericId(9)))).toBe(true);
    expect(fs.existsSync(runDir(home, todayIso, numericId(5)))).toBe(true);
  });

  it("listHistory is newest first, marks summary-less runs CRASHED, and filters by kind/state", () => {
    const finished = makeMeta();
    createRun(finished, { home });
    // A real run always leaves an events file (the store opens it at start);
    // its first line is where kind and startedAt come from.
    const finishedBus = createEventBus(finished.id);
    writeFileSyncAll(
      path.join(runDir(home, finished.date, finished.id), "events.jsonl"),
      JSON.stringify(finishedBus.emit({
        type: "RunStarted",
        kind: "worker",
        model: finished.model,
        cwd: finished.cwd,
        taskTitle: finished.taskTitle,
        taskHash: finished.taskHash,
        parent: { type: "claude" },
      })) + "\n",
    );
    finishRun(home, finished.id, makeSummary(finished.id));

    // A crashed run: an events file but no summary.json, exactly what a
    // killed process leaves behind.
    const crashed = makeMeta({ kind: "review" });
    const bus = createEventBus(crashed.id);
    const first = bus.emit({
      type: "RunStarted",
      kind: "review",
      model: crashed.model,
      cwd: crashed.cwd,
      taskTitle: crashed.taskTitle,
      taskHash: crashed.taskHash,
      parent: { type: "codex" },
    });
    writeFileSyncAll(path.join(runDir(home, crashed.date, crashed.id), "events.jsonl"), JSON.stringify(first) + "\n");

    const refs = listHistory(home);
    expect(refs.map((ref) => ref.id)).toEqual([crashed.id, finished.id]);
    expect(refs[0]).toMatchObject({ state: "CRASHED", kind: "review", summary: null });
    expect(refs[0].startedAt).toBe(first.ts);
    expect(refs[1]).toMatchObject({ state: "COMPLETED", kind: "worker" });

    expect(listHistory(home, { kind: "review" }).map((ref) => ref.id)).toEqual([crashed.id]);
    expect(listHistory(home, { state: "COMPLETED" }).map((ref) => ref.id)).toEqual([finished.id]);
  });

  it("taskTitleOf keeps only the first line, truncated to 120 chars", () => {
    expect(taskTitleOf("first line\nsecond line")).toBe("first line");
    expect(taskTitleOf("x".repeat(300))).toHaveLength(120);
    expect(taskTitleOf("")).toBe("");
  });

  it("taskHashOf is a 64-char hex that changes with the prompt", () => {
    const a = taskHashOf("prompt a");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(taskHashOf("prompt a")).toBe(a);
    expect(taskHashOf("prompt b")).not.toBe(a);
  });

  it("C3: a caller-supplied secret is redacted even when it is absent from process.env", () => {
    // The deployment case: on Windows the key lives in the User Environment,
    // never in process.env — that is the whole reason resolveZaiApiKey exists.
    // Redacting only against process.env would therefore redact nothing in
    // exactly the configuration this ships to.
    const previous = process.env[ZAI_API_KEY_ENV];
    delete process.env[ZAI_API_KEY_ENV];
    try {
      const resolved = "GLM_SK_FROM_USER_ENV_9d1c";
      const title = taskTitleOf(`rotate ${resolved} now
second line`, [resolved]);
      expect(title).toBe("rotate [REDACTED] now");
      expect(title).not.toContain(resolved);
    } finally {
      if (previous !== undefined) {
        process.env[ZAI_API_KEY_ENV] = previous;
      }
    }
  });

  it("C3: no file under runs/ contains the planted secret or the prompt body", () => {
    const planted = "GLM_SK_PLANTED_4f7a2b8c1d9e";
    const bodyMarker = "DISTINCTIVE_BODY_MARKER_77cce2aa";
    const previous = process.env[ZAI_API_KEY_ENV];
    process.env[ZAI_API_KEY_ENV] = planted;
    try {
      const prompt = `ship ${planted} rotation\n${bodyMarker}\nthird line ${planted}`;
      const meta = makeMeta({
        taskTitle: taskTitleOf(prompt),
        taskHash: taskHashOf(prompt),
      });
      expect(meta.taskTitle).toBe("ship [REDACTED] rotation");

      createRun(meta, { home });
      updateRun(home, meta.id, { state: "ROUTING" });
      updateRun(home, meta.id, { heartbeatAt: new Date().toISOString() });

      // The events stream carries the same redacted title, so it leaks no more.
      const dir = runDir(home, meta.date, meta.id);
      const bus = createEventBus(meta.id);
      const store = openRunStore(dir);
      store.append(bus.emit({
        type: "RunStarted",
        kind: "worker",
        model: meta.model,
        cwd: meta.cwd,
        taskTitle: meta.taskTitle,
        taskHash: meta.taskHash,
        parent: { type: "claude" },
      }));
      store.append(bus.emit({ type: "Heartbeat", state: "RUNNING", turn: 1 }));
      store.close();

      // Walk the whole tree, not just the files we know about — twice, so
      // both the active-file phase and the post-finish artifacts are covered.
      expectNoLeak(planted);
      expectNoLeak(bodyMarker);
      finishRun(home, meta.id, makeSummary(meta.id));
      expectNoLeak(planted);
      expectNoLeak(bodyMarker);
    } finally {
      if (previous === undefined) {
        delete process.env[ZAI_API_KEY_ENV];
      } else {
        process.env[ZAI_API_KEY_ENV] = previous;
      }
    }
  });
});

describe("heartbeat (specs/v2-architecture.md Phase B)", () => {
  it("emits a Heartbeat event and refreshes heartbeatAt on every injected tick", () => {
    const meta = makeMeta();
    createRun(meta, { home });
    const bus = createEventBus(meta.id);
    const seen: WorkerEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    let fire: (() => void) | undefined;
    let unrefed = false;
    let cleared = 0;
    const handle = startHeartbeat({
      bus,
      home,
      runId: meta.id,
      getState: () => "RUNNING",
      getTurn: () => 2,
      setIntervalImpl: (tick, intervalMs) => {
        expect(intervalMs).toBe(5000); // the config-free constant, by design
        fire = tick;
        return {
          unref: () => {
            unrefed = true;
          },
        };
      },
      clearIntervalImpl: () => {
        cleared += 1;
      },
    });

    // The timer is unref'd so a stuck heartbeat can never hold the process open.
    expect(unrefed).toBe(true);

    fire!();
    expect(seen.filter((event) => event.type === "Heartbeat")).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "Heartbeat", state: "RUNNING", turn: 2, runId: meta.id });
    const entry = JSON.parse(readText(activeRunFile(home, meta.id))) as ActiveRun;
    expect(Number.isNaN(Date.parse(entry.heartbeatAt))).toBe(false);

    fire!();
    expect(seen.filter((event) => event.type === "Heartbeat")).toHaveLength(2);

    handle.stop();
    expect(cleared).toBe(1);
    handle.stop(); // idempotent: no second clear, no throw
    expect(cleared).toBe(1);
  });

  it("a tick whose active file is missing refreshes nothing and never throws", () => {
    const bus = createEventBus("run_ghost");
    let fire: (() => void) | undefined;
    startHeartbeat({
      bus,
      home,
      runId: "run_ghost",
      getState: () => "RUNNING",
      getTurn: () => 0,
      setIntervalImpl: (tick) => {
        fire = tick;
        return {};
      },
      clearIntervalImpl: () => {},
    });

    expect(() => fire!()).not.toThrow();
  });
});

function expectNoLeak(needle: string): void {
  const files = collectFiles(runsDir(home));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(readText(file).includes(needle), `${needle} leaked into ${file}`).toBe(false);
  }
}
