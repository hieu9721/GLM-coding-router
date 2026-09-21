import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../src/events/bus.js";
import type { EventBus } from "../../src/events/bus.js";
import { attachProgress, resolveProgressMode } from "../../src/tui/progress.js";
import { createWriter, paint } from "../../src/tui/render.js";

/**
 * A real Node writable that collects bytes instead of emitting them — the
 * injected stand-in for stderr (and, for the C1/C2 assertions, for stdout).
 * `isTTY` is a plain field so tests can flip it to exercise the TTY paths.
 */
class MemoryStream extends Writable {
  public isTTY = false;
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

  public lines(): string[] {
    return this.text().split("\n").filter((line) => line !== "");
  }
}

/** A representative two-turn run produced the way production produces events. */
function emitRun(bus: EventBus): void {
  bus.emit({
    type: "RunStarted",
    kind: "worker",
    model: "glm-5.3",
    cwd: "/repo/goldenpen",
    taskTitle: "Fix login",
    taskHash: "abc123",
    parent: { type: "claude" },
  });
  bus.emit({ type: "AgentInitialized", sessionId: "s-1", model: "glm-5.3", tools: ["Read", "Bash"] });
  bus.emit({ type: "TurnStarted", turn: 1 });
  bus.emit({ type: "ToolStarted", turn: 1, toolUseId: "tu1", tool: "Read", summary: "src/a.ts" });
  bus.emit({ type: "ToolCompleted", turn: 1, toolUseId: "tu1", tool: "Read", ok: true, durationMs: 120 });
  bus.emit({ type: "ToolStarted", turn: 1, toolUseId: "tu2", tool: "Grep", summary: "RefreshToken" });
  bus.emit({ type: "ToolCompleted", turn: 1, toolUseId: "tu2", tool: "Grep", ok: true, durationMs: 60 });
  bus.emit({ type: "TurnStarted", turn: 2 });
  bus.emit({ type: "ToolStarted", turn: 2, toolUseId: "tu3", tool: "Edit", summary: "src/b.ts" });
  bus.emit({ type: "FileChanged", turn: 2, path: "src/b.ts", op: "edit" });
  bus.emit({ type: "ToolCompleted", turn: 2, toolUseId: "tu3", tool: "Edit", ok: true, durationMs: 200 });
  bus.emit({ type: "RunCompleted", turns: 2, durationMs: 43210, filesChanged: 1, tokensIn: 100, tokensOut: 50 });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("progress renderer (specs/v2-architecture.md Phase C)", () => {
  it("replaying a full run writes zero bytes to the real stdout in all three modes (C1/C2)", () => {
    // An injected stdout stream that is never passed to attachProgress cannot
    // fail this assertion, so watch the REAL process.stdout instead: that is
    // the channel a careless `console.log` or a stray default would land on.
    const original = process.stdout.write.bind(process.stdout);
    const leaked: string[] = [];
    process.stdout.write = ((chunk: unknown): boolean => {
      leaked.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      for (const mode of ["rich", "nested", "off"] as const) {
        const stderr = new MemoryStream();
        const bus = createEventBus(`run_c1_${mode}`);
        const progress = attachProgress(bus, { mode, stream: stderr });
        emitRun(bus);
        progress.detach();
        // The renderer must have written somewhere real, or the assertion
        // above would pass simply because nothing rendered at all.
        if (mode === "off") {
          expect(stderr.text(), `mode=${mode}`).toBe("");
        } else {
          expect(stderr.text().length, `mode=${mode}`).toBeGreaterThan(0);
        }
      }
    } finally {
      process.stdout.write = original;
    }
    expect(leaked).toEqual([]);
  });

  it("nested renders the pinned line format for two turns, a denial and a green validation", () => {
    const stream = new MemoryStream();
    const bus = createEventBus("run_K4P9F2");
    const progress = attachProgress(bus, { mode: "nested", stream });
    bus.emit({
      type: "RunStarted",
      kind: "worker",
      model: "glm-5.3",
      cwd: "/repo/goldenpen",
      taskTitle: "Fix login",
      taskHash: "abc123",
      parent: { type: "claude" },
    });
    bus.emit({ type: "AgentInitialized", sessionId: "s-1", model: "glm-5.3", tools: [] });
    bus.emit({ type: "Heartbeat", state: "RUNNING", turn: 1 });
    bus.emit({ type: "TurnStarted", turn: 1 });
    bus.emit({ type: "ToolStarted", turn: 1, toolUseId: "tu1", tool: "Read", summary: "src/a.ts" });
    bus.emit({ type: "ToolCompleted", turn: 1, toolUseId: "tu1", tool: "Read", ok: true, durationMs: 120 });
    bus.emit({ type: "ToolStarted", turn: 1, toolUseId: "tu2", tool: "Grep", summary: "pattern" });
    bus.emit({ type: "ToolCompleted", turn: 1, toolUseId: "tu2", tool: "Grep", ok: true, durationMs: 60 });
    bus.emit({ type: "TurnStarted", turn: 2 });
    // The adapter emits ValidationStarted immediately before its ToolStarted.
    bus.emit({ type: "ValidationStarted", turn: 2, command: "python3 test_add.py" });
    bus.emit({ type: "ToolStarted", turn: 2, toolUseId: "tu3", tool: "Bash", summary: "python3 test_add.py" });
    bus.emit({
      type: "ValidationCompleted",
      turn: 2,
      command: "python3 test_add.py",
      ok: true,
      durationMs: 900,
    });
    bus.emit({
      type: "ToolDenied",
      turn: 2,
      toolUseId: "tu4",
      tool: "Bash",
      reason: "This command requires approval",
    });
    bus.emit({ type: "RunCompleted", turns: 2, durationMs: 43210, filesChanged: 1, tokensIn: 100, tokensOut: 50 });
    progress.detach();
    expect(stream.lines()).toEqual([
      "[GLM] ● #P9F2 started • glm-5.3",
      "[GLM] turn 1 • exploring src/a.ts",
      "[GLM] turn 2 • running tests python3 test_add.py",
      "[GLM] ✓ tests passed",
      "[GLM] ⚠ denied: Bash — This command requires approval",
      "[GLM] ✓ #P9F2 • 43.2s • 2 turns • 1 files",
    ]);
  });

  it("nested prints nothing for Heartbeat or AgentInitialized", () => {
    const stream = new MemoryStream();
    const bus = createEventBus("run_silent");
    const progress = attachProgress(bus, { mode: "nested", stream });
    bus.emit({ type: "AgentInitialized", sessionId: "s-1", model: "glm-5.3", tools: [] });
    bus.emit({ type: "Heartbeat", state: "RUNNING", turn: 1 });
    bus.emit({ type: "Heartbeat", state: "RUNNING", turn: 1 });
    bus.emit({ type: "TurnStarted", turn: 1 });
    progress.detach();
    expect(stream.text()).toBe("");
  });

  it("nested closes with the failure, cancellation and retry lines", () => {
    const failed = new MemoryStream();
    const failedBus = createEventBus("run_FAIL01");
    const failedProgress = attachProgress(failedBus, { mode: "nested", stream: failed });
    failedBus.emit({ type: "ApiRetry", attempt: 1, reason: "connection reset" });
    failedBus.emit({
      type: "RunFailed",
      reason: "error_max_turns",
      exitCode: 40,
    });
    failedProgress.detach();
    expect(failed.lines()).toEqual([
      "[GLM] ⚠ retry: connection reset",
      "[GLM] ✗ #IL01 • error_max_turns",
    ]);

    const cancelled = new MemoryStream();
    const cancelledBus = createEventBus("run_CANC02");
    const cancelledProgress = attachProgress(cancelledBus, { mode: "nested", stream: cancelled });
    cancelledBus.emit({ type: "RunCancelled", signal: "SIGINT" });
    cancelledProgress.detach();
    expect(cancelled.lines()).toEqual(["[GLM] ✗ #NC02 • cancelled"]);
  });

  it("nested defaults to no colour even on a TTY stream", () => {
    const stream = new MemoryStream();
    stream.isTTY = true;
    const bus = createEventBus("run_PLAIN3");
    const progress = attachProgress(bus, { mode: "nested", stream });
    emitRun(bus);
    progress.detach();
    expect(stream.text()).not.toContain("\u001b");
  });

  it("off writes nothing at all to either stream", () => {
    const stderr = new MemoryStream();
    const stdout = new MemoryStream();
    const bus = createEventBus("run_off");
    const progress = attachProgress(bus, { mode: "off", stream: stderr });
    emitRun(bus);
    progress.detach();
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toBe("");
  });

  it("rich into a non-TTY stream renders box, tree and footer with no ANSI escapes", () => {
    const stream = new MemoryStream();
    const bus = createEventBus("run_rich01");
    const progress = attachProgress(bus, { mode: "rich", stream, project: "goldenpen" });
    emitRun(bus);
    progress.detach();
    const text = stream.text();
    expect(text).toContain("╭─ GLM Worker");

    // The header box was shipped two characters short: rows render as
    // "| " + content + " |" while the borders were drawn at content width.
    // `toContain` on the opening glyphs could not see it, so pin the geometry.
    const box = text.split("\n").filter((l) => /^[╭│╰]/.test(l));
    expect(box.length).toBe(5);
    const widths = new Set(box.map((l) => [...l].length));
    expect(widths.size, `box lines are ragged: ${JSON.stringify(box)}`).toBe(1);
    expect(text).toContain("│ Project  goldenpen");
    expect(text).toContain("◉ Turn 1");
    expect(text).toContain("◉ Turn 2");
    expect(text).toContain("└─ ");
    expect(text).toContain("✓ Completed");
    expect(text).toContain(`Duration   ${(43210 / 1000).toFixed(1)}s`);
    expect(text).toContain("Turns      2");
    expect(text).toContain("Files      1");
    // Not a TTY and color off: a piped rich render must stay byte-clean.
    expect(text).not.toContain("\u001b");
  });

  it("rich on a TTY hides the cursor, redraws in place, and detach restores it", () => {
    const stream = new MemoryStream();
    stream.isTTY = true;
    const bus = createEventBus("run_tty001");
    const progress = attachProgress(bus, { mode: "rich", stream, project: "p" });
    bus.emit({
      type: "RunStarted",
      kind: "worker",
      model: "glm-5.3",
      cwd: "/repo/p",
      taskTitle: "t",
      taskHash: "h",
      parent: { type: "shell" },
    });
    bus.emit({ type: "TurnStarted", turn: 1 });
    bus.emit({ type: "ToolStarted", turn: 1, toolUseId: "tu1", tool: "Read", summary: "src/a.ts" });
    bus.emit({ type: "ToolStarted", turn: 1, toolUseId: "tu2", tool: "Read", summary: "src/b.ts" });
    // No terminal event: detach itself must put the cursor back.
    progress.detach();
    const text = stream.text();
    expect(text).toContain("\u001b[?25l");
    expect(text).toContain("\u001b[1A");
    expect(text.indexOf("\u001b[?25h")).toBeGreaterThan(-1);
  });

  it("NO_COLOR makes a TTY writer produce no escape codes", () => {
    vi.stubEnv("NO_COLOR", "1");
    const stream = new MemoryStream();
    stream.isTTY = true;
    const writer = createWriter(stream);
    expect(writer.color).toBe(false);
    writer.line(`✓ ${paint(writer, "green", "tests passed")}`);
    writer.line(paint(writer, "cyan", "◉ Turn 1"));
    expect(stream.text()).not.toContain("\u001b");
  });
});

describe("resolveProgressMode", () => {
  it("--no-progress forces off even against an env override", () => {
    expect(resolveProgressMode({ flagOff: true, env: { GLM_ROUTER_PROGRESS: "rich" }, isTTY: true })).toBe("off");
  });

  it("--quiet forces off", () => {
    expect(resolveProgressMode({ quiet: true, env: {}, isTTY: true })).toBe("off");
  });

  it("CI=true forces off", () => {
    expect(resolveProgressMode({ env: { CI: "true" }, isTTY: true })).toBe("off");
  });

  it("GLM_ROUTER_PROGRESS=off forces off", () => {
    expect(resolveProgressMode({ env: { GLM_ROUTER_PROGRESS: "off" }, isTTY: true })).toBe("off");
  });

  it("GLM_ROUTER_PROGRESS=rich selects rich", () => {
    expect(resolveProgressMode({ env: { GLM_ROUTER_PROGRESS: "rich" }, isTTY: false })).toBe("rich");
  });

  it("GLM_ROUTER_PROGRESS=nested selects nested", () => {
    expect(resolveProgressMode({ env: { GLM_ROUTER_PROGRESS: "nested" }, isTTY: true })).toBe("nested");
  });

  it("GLM_ROUTER_NESTED=1 selects nested", () => {
    expect(resolveProgressMode({ env: { GLM_ROUTER_NESTED: "1" }, isTTY: true })).toBe("nested");
  });

  it("an env override beats the config mode", () => {
    expect(
      resolveProgressMode({ env: { GLM_ROUTER_PROGRESS: "nested" }, configMode: "rich", isTTY: true }),
    ).toBe("nested");
  });

  it("config mode rich is honoured", () => {
    expect(resolveProgressMode({ env: {}, configMode: "rich", isTTY: false })).toBe("rich");
  });

  it("config mode nested is honoured", () => {
    expect(resolveProgressMode({ env: {}, configMode: "nested", isTTY: true })).toBe("nested");
  });

  it("config mode off is honoured", () => {
    expect(resolveProgressMode({ env: {}, configMode: "off", isTTY: true })).toBe("off");
  });

  it("config auto on a TTY picks rich", () => {
    expect(resolveProgressMode({ env: {}, configMode: "auto", isTTY: true })).toBe("rich");
  });

  it("config auto without a TTY picks nested", () => {
    expect(resolveProgressMode({ env: {}, configMode: "auto", isTTY: false })).toBe("nested");
  });

  it("no config mode and no TTY picks nested", () => {
    expect(resolveProgressMode({ env: {}, isTTY: false })).toBe("nested");
  });
});
