import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../src/events/bus.js";
import type { WorkerEvent } from "../../src/events/types.js";
import { openRunStore, readEvents, summarize } from "../../src/runs/store.js";
import { makeTempDir, readText, removeTempDir } from "../helpers/tmp.js";

// Every test writes to its own temp run directory; nothing here touches a
// real config dir, and nothing depends on timers or sleeps.
let dir: string;

beforeEach(() => {
  dir = makeTempDir("glm-store-test-");
});

afterEach(() => {
  removeTempDir(dir);
});

describe("run store (specs/v2-architecture.md Phase B)", () => {
  it("append writes one compact JSON line per event and readEvents round-trips them in order", () => {
    const bus = createEventBus("run_roundtrip");
    const store = openRunStore(dir);
    expect(store.path).toBe(path.join(dir, "events.jsonl"));

    const events: WorkerEvent[] = [
      bus.emit({
        type: "RunStarted",
        kind: "worker",
        model: "glm-5.3",
        cwd: path.join("repo"),
        taskTitle: "Fix login",
        taskHash: "0".repeat(64),
        parent: { type: "claude" },
      }),
      bus.emit({ type: "TurnStarted", turn: 1 }),
      bus.emit({ type: "FileChanged", turn: 1, path: "src/a.ts", op: "edit" }),
    ];
    for (const event of events) {
      store.append(event);
    }
    store.flush();
    store.close();

    const raw = readText(store.path);
    expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(3);
    expect(raw).toContain('"type":"RunStarted"'); // one line, no pretty printing
    expect(readEvents(dir)).toEqual(events);
  });

  it("a truncated final line — the normal wreckage of a crash — is skipped and earlier events survive", () => {
    const bus = createEventBus("run_truncated");
    const store = openRunStore(dir);
    const intact: WorkerEvent[] = [
      bus.emit({ type: "TurnStarted", turn: 1 }),
      bus.emit({ type: "ToolStarted", turn: 1, toolUseId: "tu1", tool: "Read", summary: "src/a.ts" }),
    ];
    for (const event of intact) {
      store.append(event);
    }
    store.close();

    // Simulate the crash: a half-written object with no trailing newline.
    fs.appendFileSync(store.path, '{"type":"ToolStarted","turn":3,');

    expect(readEvents(dir)).toEqual(intact);
  });

  it("readEvents on a run directory with no events file returns an empty stream", () => {
    expect(readEvents(dir)).toEqual([]);
  });

  it("summarize rebuilds turns, files, denials, retries and validation from events alone", () => {
    const bus = createEventBus("run_sum");
    const events: WorkerEvent[] = [
      bus.emit({
        type: "RunStarted",
        kind: "worker",
        model: "glm-5.3",
        cwd: path.join("repo"),
        taskTitle: "Fix login",
        taskHash: "0".repeat(64),
        parent: { type: "claude" },
      }),
      bus.emit({ type: "TurnStarted", turn: 1 }),
      bus.emit({ type: "FileChanged", turn: 1, path: "src/a.ts", op: "edit" }),
      // The same path twice: filesChanged counts distinct paths, not edits.
      bus.emit({ type: "FileChanged", turn: 1, path: "src/a.ts", op: "edit" }),
      bus.emit({ type: "FileChanged", turn: 1, path: "src/b.ts", op: "write" }),
      bus.emit({ type: "TurnStarted", turn: 2 }),
      bus.emit({ type: "ToolDenied", turn: 2, toolUseId: "tu9", tool: "Bash", reason: "requires approval" }),
      bus.emit({ type: "ApiRetry", attempt: 1, reason: "Retrying (429)" }),
      bus.emit({ type: "ValidationStarted", turn: 2, command: "npm run test" }),
      bus.emit({ type: "ValidationCompleted", turn: 2, command: "npm run test", ok: true, durationMs: 900 }),
      bus.emit({
        type: "RunCompleted",
        turns: 2,
        durationMs: 5000,
        filesChanged: 2,
        tokensIn: 100,
        tokensOut: 50,
      }),
    ];

    expect(summarize(events)).toEqual({
      id: "run_sum",
      state: "COMPLETED",
      turns: 2,
      durationMs: 5000,
      filesChanged: ["src/a.ts", "src/b.ts"],
      tokensIn: 100,
      tokensOut: 50,
      denied: 1,
      retries: 1,
      validation: "ok",
    });
  });

  it("summarize marks a stream with no terminal event as CRASHED and derives duration from timestamps", () => {
    let clock = new Date("2026-09-20T10:00:00.000Z");
    const bus = createEventBus("run_crashed", { now: () => clock });
    const events: WorkerEvent[] = [];
    events.push(bus.emit({
      type: "RunStarted",
      kind: "worker",
      model: "glm-5.3",
      cwd: path.join("repo"),
      taskTitle: "Fix login",
      taskHash: "0".repeat(64),
      parent: { type: "shell" },
    }));
    clock = new Date("2026-09-20T10:00:07.000Z");
    events.push(bus.emit({ type: "TurnStarted", turn: 1 }));

    const summary = summarize(events);
    // CRASHED is exactly "the stream ended with no terminal event": a run
    // killed mid-flight leaves numbers only the events can supply.
    expect(summary.state).toBe("CRASHED");
    expect(summary.durationMs).toBe(7000);
    expect(summary.turns).toBe(1);
    expect(summary.tokensIn).toBe(0);
    expect(summary.tokensOut).toBe(0);
  });

  it("summarize reports denied, pending and failed validations and maps the terminal states", () => {
    const bus = createEventBus("run_validations");

    const denied = summarize([
      bus.emit({ type: "ValidationStarted", turn: 1, command: "npm run test" }),
      bus.emit({ type: "ToolDenied", turn: 1, toolUseId: "tu1", tool: "Bash", reason: "requires approval" }),
      bus.emit({ type: "RunFailed", reason: "child_error", exitCode: 40 }),
    ]);
    expect(denied.validation).toBe("denied");
    expect(denied.state).toBe("FAILED");

    const pending = summarize([
      bus.emit({ type: "ValidationStarted", turn: 1, command: "npm run test" }),
      bus.emit({ type: "RunCancelled", signal: "SIGINT" }),
    ]);
    expect(pending.validation).toBe("pending");
    expect(pending.state).toBe("CANCELLED");

    const failed = summarize([
      bus.emit({ type: "ValidationStarted", turn: 1, command: "npm run test" }),
      bus.emit({ type: "ValidationCompleted", turn: 1, command: "npm run test", ok: false, durationMs: 10 }),
    ]);
    expect(failed.validation).toBe("failed");
    expect(failed.state).toBe("CRASHED"); // no terminal event at all
  });

  it("no event body written to disk contains a thinking field (C3)", () => {
    const bus = createEventBus("run_nothink");
    const store = openRunStore(dir);
    store.append(bus.emit({
      type: "RunStarted",
      kind: "worker",
      model: "glm-5.3",
      cwd: path.join("repo"),
      taskTitle: "Fix login",
      taskHash: "0".repeat(64),
      parent: { type: "claude" },
    }));
    store.append(bus.emit({ type: "Heartbeat", state: "RUNNING", turn: 0 }));
    store.close();

    const raw = readText(store.path);
    expect(raw).not.toContain("thinking");
    for (const event of readEvents(dir)) {
      expect(Object.keys(event)).not.toContain("thinking");
    }
  });

  it("accumulates across a run that carries several result messages", () => {
    // Observed live on 2026-09-20: a child that hits --max-turns and continues
    // emits one result per segment. Overwriting made a 21-minute, 64-turn run
    // persist as "88s, 5 turns" — the summary contradicted its own TurnStarted
    // events. Each result covers only its segment, so they accumulate, and the
    // derived turn count wins when it is larger.
    const bus = createEventBus("run_multi");
    const events: WorkerEvent[] = [];
    const collect = (e: WorkerEvent): void => void events.push(e);
    bus.subscribe(collect);
    for (let turn = 1; turn <= 64; turn++) {
      bus.emit({ type: "TurnStarted", turn });
    }
    bus.emit({ type: "RunFailed", reason: "max_turns", exitCode: 1 });
    bus.emit({ type: "RunCompleted", turns: 0, durationMs: 123, filesChanged: 0, tokensIn: 0, tokensOut: 0 });
    bus.emit({ type: "RunCompleted", turns: 5, durationMs: 88_074, filesChanged: 0, tokensIn: 4891, tokensOut: 3851 });

    const summary = summarize(events);
    expect(summary.turns).toBe(64);
    expect(summary.durationMs).toBeGreaterThanOrEqual(88_074 + 123);
    expect(summary.tokensIn).toBe(4891);
    expect(summary.tokensOut).toBe(3851);
    expect(summary.state).toBe("COMPLETED");
  });
});
