import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../src/events/bus.js";
import type { WorkerEvent } from "../../src/events/types.js";
import { logger } from "../../src/core/logging.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("event bus (specs/v2-architecture.md Phase A)", () => {
  it("stamps seq starting at 1, monotonically, across mixed event types", () => {
    const bus = createEventBus("run_seq");
    const first = bus.emit({
      type: "RunStarted",
      kind: "worker",
      model: "glm-5.3",
      cwd: "/repo",
      taskTitle: "Fix login",
      taskHash: "abc123",
      parent: { type: "claude" },
    });
    const second = bus.emit({ type: "TurnStarted", turn: 1 });
    const third = bus.emit({ type: "ToolStarted", turn: 1, toolUseId: "tu1", tool: "Read", summary: "src/a.ts" });
    const fourth = bus.emit({ type: "Heartbeat", state: "RUNNING", turn: 1 });
    expect([first.seq, second.seq, third.seq, fourth.seq]).toEqual([1, 2, 3, 4]);
    expect(first.type).toBe("RunStarted");
    expect(fourth.type).toBe("Heartbeat");
  });

  it("stamps runId and honours an injected clock with a valid ISO ts", () => {
    const fixed = new Date("2026-09-20T10:30:00.000Z");
    const bus = createEventBus("run_fixed", { now: () => fixed });
    const event = bus.emit({ type: "TurnStarted", turn: 1 });
    expect(event.runId).toBe("run_fixed");
    expect(event.ts).toBe("2026-09-20T10:30:00.000Z");
  });

  it("stamps a real, parseable ISO ts when no clock is injected", () => {
    const before = Date.now();
    const bus = createEventBus("run_real");
    const event = bus.emit({ type: "Heartbeat", state: "RUNNING", turn: 0 });
    const parsed = Date.parse(event.ts);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before);
  });

  it("stamps provider zai.zcode and role worker by default on every event (H2)", () => {
    const bus = createEventBus("run_defaults");
    const events: WorkerEvent[] = [
      bus.emit({
        type: "RunStarted",
        kind: "worker",
        model: "glm-5.3",
        cwd: "/repo",
        taskTitle: "Fix login",
        taskHash: "abc123",
        parent: { type: "claude" },
      }),
      bus.emit({ type: "TurnStarted", turn: 1 }),
      bus.emit({ type: "Heartbeat", state: "RUNNING", turn: 1 }),
    ];
    for (const event of events) {
      expect(event.provider).toBe("zai.zcode");
      expect(event.role).toBe("worker");
    }
  });

  it("taskId defaults to the runId while there is no task graph (H1)", () => {
    const bus = createEventBus("run_implicit_task");
    const event = bus.emit({ type: "TurnStarted", turn: 1 });
    expect(event.taskId).toBe("run_implicit_task");
  });

  it("honours an explicit taskId and role reviewer on every event from that bus", () => {
    const bus = createEventBus("run_review", { taskId: "task_42", role: "reviewer" });
    const events: WorkerEvent[] = [
      bus.emit({
        type: "RunStarted",
        kind: "review",
        model: "glm-5.3",
        cwd: "/repo",
        taskTitle: "Review login fix",
        taskHash: "def456",
        parent: { type: "codex" },
      }),
      bus.emit({ type: "TurnStarted", turn: 1 }),
    ];
    for (const event of events) {
      expect(event.taskId).toBe("task_42");
      expect(event.role).toBe("reviewer");
    }
  });

  it("exposes runId and taskId as properties without waiting for an event", () => {
    const bus = createEventBus("run_props", { taskId: "task_props" });
    expect(bus.runId).toBe("run_props");
    expect(bus.taskId).toBe("task_props");
  });

  it("delivers synchronously, in subscription order", () => {
    const bus = createEventBus("run_order");
    const order: string[] = [];
    bus.subscribe((event) => order.push(`first:${event.type}`));
    bus.subscribe((event) => order.push(`second:${event.type}`));
    // No await anywhere: both entries must already be there when emit returns.
    bus.emit({ type: "TurnStarted", turn: 1 });
    expect(order).toEqual(["first:TurnStarted", "second:TurnStarted"]);
  });

  it("a throwing subscriber neither breaks emit nor starves later subscribers", () => {
    const bus = createEventBus("run_throw");
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("renderer exploded");
    });
    bus.subscribe((event) => seen.push(event.type));
    expect(() => bus.emit({ type: "TurnStarted", turn: 2 })).not.toThrow();
    expect(seen).toEqual(["TurnStarted"]);
  });

  it("reports a throwing subscriber through the debug logger", () => {
    const debug = vi.spyOn(logger, "debug");
    const bus = createEventBus("run_debug");
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.emit({ type: "TurnStarted", turn: 1 });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[0]).toContain("TurnStarted");
  });

  it("unsubscribe stops delivery to that listener only", () => {
    const bus = createEventBus("run_unsub");
    const seenA: string[] = [];
    const seenB: string[] = [];
    const unsubscribeA = bus.subscribe((event) => seenA.push(event.type));
    bus.subscribe((event) => seenB.push(event.type));
    bus.emit({ type: "TurnStarted", turn: 1 });
    unsubscribeA();
    bus.emit({ type: "TurnStarted", turn: 2 });
    expect(seenA).toEqual(["TurnStarted"]);
    expect(seenB).toEqual(["TurnStarted", "TurnStarted"]);
  });

  it("after close(), emit still stamps and returns the event but dispatches to nobody", () => {
    const bus = createEventBus("run_close");
    const seen: WorkerEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    bus.close();
    const event = bus.emit({ type: "RunCancelled", signal: "SIGINT" });
    expect(event.runId).toBe("run_close");
    expect(event.seq).toBe(1);
    expect(event.type).toBe("RunCancelled");
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
    expect(seen).toEqual([]);
  });

  it("subscribe after close is a no-op returning a no-op unsubscribe", () => {
    const bus = createEventBus("run_late");
    bus.close();
    const seen: WorkerEvent[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event));
    expect(() => unsubscribe()).not.toThrow();
    bus.emit({ type: "TurnStarted", turn: 1 });
    expect(seen).toEqual([]);
  });
});
