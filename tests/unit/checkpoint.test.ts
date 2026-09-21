import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus, type EventInput } from "../../src/events/bus.js";
import type { WorkerEvent } from "../../src/events/types.js";
import { buildCheckpoint, writeCheckpoint, type Checkpoint } from "../../src/runs/checkpoint.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

const RUN_ID = "run_checkpoint_fixture_01";

/** Stamps a fabricated event sequence the way the real bus would. */
function replay(inputs: readonly EventInput[]): WorkerEvent[] {
  const bus = createEventBus(RUN_ID);
  return inputs.map((input) => bus.emit(input));
}

function started(title: string): EventInput {
  return {
    type: "RunStarted",
    kind: "worker",
    model: "glm-5.3",
    cwd: path.join("repo"),
    taskTitle: title,
    taskHash: "0".repeat(64),
    parent: { type: "claude" },
  };
}

/** One closed tool cycle. `ok = false` models a tool that errored. */
function toolUse(turn: number, tool: string, summary: string, ok = true): EventInput[] {
  const toolUseId = `tu-${turn}-${tool}-${summary}`;
  return [
    { type: "ToolStarted", turn, toolUseId, tool, summary },
    { type: "ToolCompleted", turn, toolUseId, tool, ok, durationMs: 12 },
  ];
}

/** An ok edit cycle, including the FileChanged only an ok edit produces. */
function editUse(turn: number, filePath: string): EventInput[] {
  return [...toolUse(turn, "Edit", filePath), { type: "FileChanged", turn, path: filePath, op: "edit" }];
}

/** A validation command; `ok` omitted models one still open when the run stopped. */
function validation(turn: number, command: string, ok?: boolean): EventInput[] {
  const toolUseId = `tu-${turn}-Bash-${command}`;
  const events: EventInput[] = [
    { type: "ValidationStarted", turn, command },
    { type: "ToolStarted", turn, toolUseId, tool: "Bash", summary: command },
  ];
  if (ok !== undefined) {
    events.push(
      { type: "ToolCompleted", turn, toolUseId, tool: "Bash", ok, durationMs: 900 },
      { type: "ValidationCompleted", turn, command, ok, durationMs: 900 },
    );
  }
  return events;
}

describe("buildCheckpoint (specs/v2-architecture.md Phase F)", () => {
  it("an empty event stream is the exploration floor, not a throw", () => {
    expect(buildCheckpoint([])).toEqual({
      runId: "",
      phase: "exploration",
      completed: [],
      // No RunStarted → the one honest pending entry, nothing fabricated (C3).
      pending: ["continue the task"],
      filesChanged: [],
      validationPending: [],
    });
  });

  it("phase=exploration: last tool-active turn only read", () => {
    const checkpoint = buildCheckpoint(
      replay([
        started("Map the config layer"),
        { type: "TurnStarted", turn: 1 },
        ...toolUse(1, "Read", "src/config.ts"),
        { type: "TurnStarted", turn: 2 },
        ...toolUse(2, "Grep", "quota"),
        {
          type: "RunCompleted",
          turns: 2,
          durationMs: 5000,
          filesChanged: 0,
          tokensIn: 100,
          tokensOut: 50,
        },
      ]),
    );

    expect(checkpoint.phase).toBe("exploration");
    // Both turns finished: the run reached a terminal event.
    expect(checkpoint.completed).toEqual(["turn 1: Read src/config.ts", "turn 2: Grep quota"]);
    expect(checkpoint.pending).toEqual(["Map the config layer"]);
    expect(checkpoint.filesChanged).toEqual([]);
  });

  it("phase=implementation: last tool-active turn edited a file", () => {
    const checkpoint = buildCheckpoint(
      replay([
        started("Add the quota probe"),
        { type: "TurnStarted", turn: 1 },
        ...toolUse(1, "Read", "src/probe.ts"),
        { type: "TurnStarted", turn: 2 },
        ...editUse(2, "src/probe.ts"),
        // No terminal event: turn 2 is the one in progress at handoff time.
      ]),
    );

    expect(checkpoint.phase).toBe("implementation");
    expect(checkpoint.completed).toEqual(["turn 1: Read src/probe.ts"]);
    expect(checkpoint.filesChanged).toEqual(["src/probe.ts"]);
  });

  it("phase=validation: last tool-active turn started a validation (mid-turn stop)", () => {
    const checkpoint = buildCheckpoint(
      replay([
        started("Fix the failing suite"),
        { type: "TurnStarted", turn: 1 },
        ...toolUse(1, "Read", "src/auth.ts"),
        { type: "TurnStarted", turn: 2 },
        ...editUse(2, "src/auth.ts"),
        { type: "TurnStarted", turn: 3 },
        // The child dies here: the validation started, nothing completed it.
        ...validation(3, "npm test"),
      ]),
    );

    expect(checkpoint.phase).toBe("validation");
    expect(checkpoint.completed).toEqual(["turn 1: Read src/auth.ts", "turn 2: Edit src/auth.ts"]);
    // The mid-turn stop lands in validationPending...
    expect(checkpoint.validationPending).toEqual(["npm test"]);
    // ...and pending is the title plus that owed entry (C3: no prompt parsing).
    expect(checkpoint.pending).toEqual(["Fix the failing suite", "npm test"]);
  });

  it("a FAILED validation stays owed even after its turn finished", () => {
    const checkpoint = buildCheckpoint(
      replay([
        started("Ship it"),
        { type: "TurnStarted", turn: 1 },
        ...validation(1, "npm test", false),
        { type: "TurnStarted", turn: 2 },
        ...toolUse(2, "Read", "src/other.ts"),
        { type: "RunFailed", reason: "child_error", exitCode: 40 },
      ]),
    );

    expect(checkpoint.validationPending).toEqual(["npm test"]);
    // Turn 1 finished (a later turn started AND the run terminated) — being
    // finished is not the same as having satisfied the validation.
    expect(checkpoint.completed).toEqual(["turn 1: Bash npm test", "turn 2: Read src/other.ts"]);
    // Per the ruling the phase is the mix of the LAST tool-active turn (2),
    // which only read — not the turn that failed its validation.
    expect(checkpoint.phase).toBe("exploration");
  });

  it("a denied validation counts as owed (A0), and its tool is still reported", () => {
    const checkpoint = buildCheckpoint(
      replay([
        started("Harden the endpoint"),
        { type: "TurnStarted", turn: 1 },
        { type: "ValidationStarted", turn: 1, command: "npm test" },
        // Started, then denied — the adapter drops the pending cycle on
        // permission_denied, so no ToolCompleted ever arrives either.
        { type: "ToolStarted", turn: 1, toolUseId: "tu-1-Bash-npm test", tool: "Bash", summary: "npm test" },
        { type: "ToolDenied", turn: 1, toolUseId: "tu-1-Bash-npm test", tool: "Bash", reason: "not on the Bash allowlist" },
        { type: "TurnStarted", turn: 2 },
        ...toolUse(2, "Read", "src/a.ts"),
        { type: "RunCancelled", signal: "SIGINT" },
      ]),
    );

    expect(checkpoint.validationPending).toEqual(["npm test"]);
    // The denied tool's started summary is still part of what the turn did.
    expect(checkpoint.completed).toEqual(["turn 1: Bash npm test", "turn 2: Read src/a.ts"]);
    expect(checkpoint.pending).toEqual(["Harden the endpoint", "npm test"]);
  });

  it("without a RunStarted, pending is exactly the single fallback entry", () => {
    const checkpoint = buildCheckpoint(
      replay([
        { type: "TurnStarted", turn: 1 },
        ...editUse(1, "src/x.ts"),
        { type: "RunCancelled", signal: "SIGINT" },
      ]),
    );

    expect(checkpoint.pending).toEqual(["continue the task"]);
    expect(checkpoint.filesChanged).toEqual(["src/x.ts"]);
    expect(checkpoint.runId).toBe(RUN_ID);
  });

  it("filesChanged is de-duplicated in first-seen order and completed lines are capped at 120 chars", () => {
    const noisyTurn: EventInput[] = [];
    for (let i = 0; i < 30; i += 1) {
      noisyTurn.push(...toolUse(1, "Read", `src/module-${i}-with-a-deliberately-long-name.ts`));
    }

    const checkpoint = buildCheckpoint(
      replay([
        started("Sweep the tree"),
        { type: "TurnStarted", turn: 1 },
        ...noisyTurn,
        { type: "TurnStarted", turn: 2 },
        ...editUse(2, "src/a.ts"),
        ...editUse(2, "src/b.ts"),
        ...editUse(2, "src/a.ts"),
        {
          type: "RunCompleted",
          turns: 2,
          durationMs: 1000,
          filesChanged: 2,
          tokensIn: 10,
          tokensOut: 5,
        },
      ]),
    );

    expect(checkpoint.filesChanged).toEqual(["src/a.ts", "src/b.ts"]);
    expect(checkpoint.completed[0]).toHaveLength(120);
    expect(checkpoint.completed[0].startsWith("turn 1: Read src/module-0-")).toBe(true);
    expect(checkpoint.completed[1]).toBe("turn 2: Edit src/a.ts, Edit src/b.ts, Edit src/a.ts");
  });
});

describe("writeCheckpoint", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("glm-checkpoint-test-");
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  function sample(): Checkpoint {
    return buildCheckpoint(
      replay([
        started("Sample task"),
        { type: "TurnStarted", turn: 1 },
        ...editUse(1, "src/a.ts"),
        { type: "RunCompleted", turns: 1, durationMs: 100, filesChanged: 1, tokensIn: 1, tokensOut: 1 },
      ]),
    );
  }

  it("writes checkpoint.json and returns its path", () => {
    const checkpoint = sample();

    const file = writeCheckpoint(dir, checkpoint);

    expect(file).toBe(path.join(dir, "checkpoint.json"));
    expect(JSON.parse(readText(file ?? ""))).toEqual(checkpoint);
  });

  it("returns null instead of throwing when the run dir cannot be created", () => {
    const occupied = path.join(dir, "occupied.txt");
    writeFileSyncAll(occupied, "a file where a directory should be");

    expect(writeCheckpoint(occupied, sample())).toBeNull();
  });
});

describe("buildCheckpoint: the wreckage a crash actually leaves (regression)", () => {
  // Found by mutation test in review: deleting the "a failed completion is
  // owed" clause left all ten tests above green, because every one of them
  // pairs a ValidationCompleted with its ValidationStarted — and the
  // started-but-never-ok clause already covers that pair. The clause only
  // earns its keep when the START is the line that went missing, which is
  // exactly what readEvents produces from a truncated or corrupted stream
  // (it skips malformed lines and keeps the rest).
  it("a failed validation whose ValidationStarted was lost is still owed", () => {
    const events = replay([
      started("Fix the parser"),
      { type: "TurnStarted", turn: 1 },
      ...editUse(1, "src/parser.ts"),
      // No ValidationStarted: that line did not survive the crash.
      { type: "ValidationCompleted", turn: 1, command: "npm test", ok: false, durationMs: 900 },
    ]);

    const checkpoint = buildCheckpoint(events);

    expect(checkpoint.validationPending).toEqual(["npm test"]);
    expect(checkpoint.pending).toContain("npm test");
  });

  it("an ok validation whose ValidationStarted was lost is NOT owed", () => {
    // The mirror case, so the rule above cannot be satisfied by simply
    // reporting every completion it sees.
    const events = replay([
      started("Fix the parser"),
      { type: "TurnStarted", turn: 1 },
      ...editUse(1, "src/parser.ts"),
      { type: "ValidationCompleted", turn: 1, command: "npm test", ok: true, durationMs: 900 },
    ]);

    expect(buildCheckpoint(events).validationPending).toEqual([]);
  });
});
