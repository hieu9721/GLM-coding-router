import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adaptClaudeMessage,
  createAdapterState,
  createStreamAdapter,
} from "../../src/events/claude-adapter.js";
import { createEventBus } from "../../src/events/bus.js";
import type { EventInput } from "../../src/events/bus.js";

/**
 * Phase A adapter tests (specs/v2-architecture.md). The three replayed
 * fixtures are A0's real captured streams (Claude Code 2.1.278 over GLM-5.3),
 * scrubbed to be deterministic — so these assertions pin the adapter against
 * what the schema actually looks like, not what it was assumed to look like.
 */

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/streams", import.meta.url));

/** The captured runs' cwd; paths under it must come out repo-relative. */
const FIXTURE_CWD = "/home/user/project";

/**
 * A frozen clock makes the replay deterministic: exactly one Heartbeat fires
 * (on the first thinking_tokens line of the whole replay) and every later
 * counter line is throttled away, because the clock never advances.
 */
const FROZEN_NOW = () => 1_000_000;

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

function replayFixture(name: string): EventInput[] {
  const adapter = createStreamAdapter(FIXTURE_CWD, { now: FROZEN_NOW });
  const events: EventInput[] = [];
  for (const line of readFixture(name).split(/\r?\n/)) {
    events.push(...adapter.onStdoutLine(line));
  }
  return events;
}

type Narrowed<T extends EventInput["type"]> = Extract<EventInput, { type: T }>;

function pickAll<T extends EventInput["type"]>(
  events: readonly EventInput[],
  type: T,
): Narrowed<T>[] {
  return events.filter((event): event is Narrowed<T> => event.type === type);
}

function pick<T extends EventInput["type"]>(events: readonly EventInput[], type: T): Narrowed<T> {
  const found = events.find((event): event is Narrowed<T> => event.type === type);
  if (found === undefined) {
    throw new Error(`expected a ${type} event, got: ${JSON.stringify(events.map((e) => e.type))}`);
  }
  return found;
}

const typesOf = (events: readonly EventInput[]): string[] => events.map((event) => event.type);

describe("claude adapter (specs/v2-architecture.md Phase A)", () => {
  describe("fixture replays", () => {
    it("basic.ndjson → read-only run: init, one heartbeat, one turn, success", () => {
      const events = replayFixture("basic.ndjson");
      expect(typesOf(events)).toEqual([
        "AgentInitialized",
        "Heartbeat",
        "TurnStarted",
        "ToolStarted",
        "ToolCompleted",
        "RunCompleted",
      ]);

      const init = pick(events, "AgentInitialized");
      expect(init.sessionId).toBe("00000000-0000-4000-8000-000000000000");
      expect(init.model).toBe("glm-5.3");
      expect(init.tools).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);

      const tool = pick(events, "ToolStarted");
      expect(tool.tool).toBe("Read");
      expect(tool.toolUseId).toBe("call_fbc26179ccd04e9797a08277");
      expect(tool.summary).toBe("notes.txt"); // repo-relative, not /home/user/project/notes.txt
      expect(tool.turn).toBe(1);

      const done = pick(events, "ToolCompleted");
      expect(done.ok).toBe(true);

      const completed = pick(events, "RunCompleted");
      expect(completed.turns).toBe(2); // num_turns from the result, not the derived tally (1)
      expect(completed.durationMs).toBe(4741);
      expect(completed.filesChanged).toBe(0);
      expect(completed.tokensIn).toBe(1644);
      expect(completed.tokensOut).toBe(144);
    });

    it("edit.ndjson → two writes land, two Bash calls are denied, run still succeeds", () => {
      const events = replayFixture("edit.ndjson");
      expect(typesOf(events)).toEqual([
        "AgentInitialized",
        "TurnStarted",
        "ToolStarted",
        "ToolCompleted",
        "FileChanged",
        "TurnStarted",
        "ToolStarted",
        "ToolCompleted",
        "FileChanged",
        "TurnStarted",
        "ValidationStarted",
        "ToolStarted",
        "ToolDenied",
        "Heartbeat",
        "TurnStarted",
        "ValidationStarted",
        "ToolStarted",
        "ToolDenied",
        "RunCompleted",
      ]);

      // Derived turns: 4 tool cycles (Write, Write, Bash, Bash). The result's
      // num_turns (5) is authoritative for RunCompleted — the derived count
      // is deliberately NOT reconciled into it.
      expect(pickAll(events, "TurnStarted").map((t) => t.turn)).toEqual([1, 2, 3, 4]);

      expect(pickAll(events, "ToolStarted").map((t) => [t.tool, t.summary])).toEqual([
        ["Write", "add.py"],
        ["Write", "test_add.py"],
        ["Bash", "python3 test_add.py"],
        ["Bash", "python3 /home/user/project/test_add.py"], // a command, never relativized
      ]);

      expect(pickAll(events, "FileChanged").map((f) => [f.path, f.op])).toEqual([
        ["add.py", "write"],
        ["test_add.py", "write"],
      ]);

      const denials = pickAll(events, "ToolDenied");
      expect(denials).toHaveLength(2);
      expect(denials.map((d) => d.toolUseId)).toEqual([
        "call_db62461f0cd54b019ec2d2c1",
        "call_b6b91e19481a484bb5363aa0",
      ]);
      expect(denials.every((d) => d.tool === "Bash")).toBe(true);
      expect(denials.every((d) => d.reason === "This command requires approval")).toBe(true);
      expect(denials.map((d) => d.turn)).toEqual([3, 4]);
      // The denied tools never "complete": the error tool_results that follow
      // the denials map to nothing (no ToolCompleted with ok:false here).
      expect(pickAll(events, "ToolCompleted").every((t) => t.ok)).toBe(true);

      const completed = pick(events, "RunCompleted");
      expect(completed.turns).toBe(5);
      expect(completed.durationMs).toBe(26616);
      expect(completed.filesChanged).toBe(2);
      expect(completed.tokensIn).toBe(2145);
      expect(completed.tokensOut).toBe(545);
      // The USD fields in the fixture are fiction for this stack (A0) and
      // must not leak into the event.
      expect(JSON.stringify(completed)).not.toContain("cost");
    });

    it("allowed.ndjson → the same Bash runs clean: ok tool completion, no denial", () => {
      const events = replayFixture("allowed.ndjson");
      expect(typesOf(events)).toEqual([
        "AgentInitialized",
        "Heartbeat",
        "TurnStarted",
        "ValidationStarted",
        "ToolStarted",
        "ToolCompleted",
        "ValidationCompleted",
        "RunCompleted",
      ]);
      expect(pickAll(events, "ToolDenied")).toEqual([]);

      const done = pick(events, "ToolCompleted");
      expect(done.tool).toBe("Bash");
      expect(done.toolUseId).toBe("call_84a9d213fcc54934923a6859");
      expect(done.ok).toBe(true);

      const completed = pick(events, "RunCompleted");
      expect(completed.turns).toBe(2);
      expect(completed.durationMs).toBe(3783);
      expect(completed.filesChanged).toBe(0);
      expect(completed.tokensIn).toBe(339);
      expect(completed.tokensOut).toBe(111);
    });

    it("allowed.ndjson validates green: the captured python3 run is a real ValidationCompleted", () => {
      // This assertion flipped on 2026-09-20. The regex shipped in the spec
      // matched none of A0's captured commands, so the green validation path
      // was unreachable from real data and only covered synthetically — the
      // adapter agreed with the spec while the spec disagreed with the stack.
      // The `python3` arm closed that; `specs/worker-bash-permissions.md`
      // already allowlisted `python3 *` as a validation command.
      const events = replayFixture("allowed.ndjson");
      const started = pickAll(events, "ValidationStarted");
      const completed = pickAll(events, "ValidationCompleted");
      expect(started).toHaveLength(1);
      expect(started[0].command).toContain("test_add.py");
      expect(completed).toHaveLength(1);
      expect(completed[0].ok).toBe(true);
      // The contrast that makes both fixtures worth keeping: same command,
      // allowlisted here and denied there.
      expect(pickAll(events, "ToolDenied")).toEqual([]);
    });

    it("edit.ndjson validates red: the same command is denied, so no completion follows", () => {
      const events = replayFixture("edit.ndjson");
      expect(pickAll(events, "ValidationStarted").length).toBeGreaterThan(0);
      // A denied validation never completes — it is reported as ToolDenied.
      expect(pickAll(events, "ValidationCompleted")).toEqual([]);
      expect(pickAll(events, "ToolDenied")).toHaveLength(2);
    });

    it("chunk-feeding the whole file yields the same sequence as line-feeding", () => {
      const adapter = createStreamAdapter(FIXTURE_CWD, { now: FROZEN_NOW });
      // The trailing newline guarantees the last line flushes from the buffer.
      const events = adapter.onStdoutChunk(readFixture("edit.ndjson") + "\n");
      expect(typesOf(events)).toEqual(typesOf(replayFixture("edit.ndjson")));
    });
  });

  describe("validation lifecycle (synthetic — see the note in the fixture tests)", () => {
    it("emits ValidationStarted before ToolStarted and a green ValidationCompleted", () => {
      const adapter = createStreamAdapter("/repo", { now: () => 5_000 });
      const events = [
        ...adapter.onStdoutLine(
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm test" } },
              ],
            },
          }),
        ),
        ...adapter.onStdoutLine(
          JSON.stringify({
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }],
            },
          }),
        ),
      ];
      expect(typesOf(events)).toEqual([
        "TurnStarted",
        "ValidationStarted",
        "ToolStarted",
        "ToolCompleted",
        "ValidationCompleted",
      ]);
      expect(pick(events, "ValidationStarted").command).toBe("npm test");
      const done = pick(events, "ValidationCompleted");
      expect(done.command).toBe("npm test");
      expect(done.ok).toBe(true);
    });

    it("a denied validation is reported once; its error tool_result maps to nothing", () => {
      const adapter = createStreamAdapter("/repo");
      const events = [
        ...adapter.onStdoutLine(
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", id: "tu_v", name: "Bash", input: { command: "npx vitest run" } },
              ],
            },
          }),
        ),
        ...adapter.onStdoutLine(
          JSON.stringify({
            type: "system",
            subtype: "permission_denied",
            tool_name: "Bash",
            tool_use_id: "tu_v",
            decision_reason: "This command requires approval",
          }),
        ),
        ...adapter.onStdoutLine(
          JSON.stringify({
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: "tu_v", is_error: true, content: "denied" },
              ],
            },
          }),
        ),
      ];
      expect(typesOf(events)).toEqual([
        "TurnStarted",
        "ValidationStarted",
        "ToolStarted",
        "ToolDenied",
      ]);
    });

    it("a failed validation completes with ok false rather than vanishing", () => {
      const adapter = createStreamAdapter("/repo");
      const events = [
        ...adapter.onStdoutLine(
          JSON.stringify({
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id: "tu_f", name: "Bash", input: { command: "tsc" } }],
            },
          }),
        ),
        ...adapter.onStdoutLine(
          JSON.stringify({
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "tu_f", is_error: true, content: "exit 2" }],
            },
          }),
        ),
      ];
      const done = pick(events, "ValidationCompleted");
      expect(done.ok).toBe(false);
      expect(pick(events, "ToolCompleted").ok).toBe(false);
    });
  });

  describe("thinking_tokens throttling", () => {
    it("at most one Heartbeat per second, however many counter lines arrive", () => {
      const state = createAdapterState("/repo");
      const beats: number[] = [];
      let clock = 0;
      for (let i = 0; i < 50; i++) {
        clock += 100; // 50 lines spanning 5 seconds
        const events = adaptClaudeMessage(
          { type: "system", subtype: "thinking_tokens", estimated_tokens: i },
          state,
          () => clock,
        );
        for (const event of events) {
          if (event.type === "Heartbeat") {
            beats.push(clock);
            expect(event.state).toBe("working");
          }
        }
      }
      expect(beats.length).toBeGreaterThan(0);
      expect(beats.length).toBeLessThanOrEqual(5); // ceiling for a 5s span at 1/sec
      for (let i = 1; i < beats.length; i++) {
        expect(beats[i] - beats[i - 1]).toBeGreaterThanOrEqual(1000);
      }
    });
  });

  describe("C3: nothing raw leaves the adapter", () => {
    it("no thinking text, tool output or result body appears in any emitted event", () => {
      const serialized = ["basic.ndjson", "edit.ndjson", "allowed.ndjson"]
        .map((name) => JSON.stringify(replayFixture(name)))
        .join("\n");
      // Fragments of the fixtures' thinking blocks…
      expect(serialized).not.toContain("presumably in the working directory");
      expect(serialized).not.toContain("Let me try with the absolute path");
      expect(serialized).not.toContain("report this to the user");
      expect(serialized).not.toContain("f1c0c05546f948c28878c8bb"); // thinking signature
      // …and the tool_result / result bodies.
      expect(serialized).not.toContain("hello world");
      expect(serialized).not.toContain("File created successfully");
    });
  });

  describe("line buffering", () => {
    it("a JSON object split across two chunks parses exactly once complete", () => {
      const adapter = createStreamAdapter(FIXTURE_CWD);
      const line = JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s_split",
        model: "glm-5.3",
        tools: ["Read"],
      });
      expect(adapter.onStdoutChunk(line.slice(0, 25))).toEqual([]);
      const events = adapter.onStdoutChunk(line.slice(25) + "\r\n");
      expect(typesOf(events)).toEqual(["AgentInitialized"]);
      expect(pick(events, "AgentInitialized").sessionId).toBe("s_split");
    });

    it("one chunk carrying several complete lines consumes all of them, skipping blanks", () => {
      const adapter = createStreamAdapter("/repo");
      const init = (id: string) =>
        JSON.stringify({ type: "system", subtype: "init", session_id: id, model: "m", tools: [] });
      const events = adapter.onStdoutChunk(`${init("a")}\n\n   \n${init("b")}\n`);
      expect(typesOf(events)).toEqual(["AgentInitialized", "AgentInitialized"]);
    });
  });

  describe("defensive mapping — never throw, no stray events", () => {
    it("survives garbage, unknown types, unknown subtypes and truncated lines", () => {
      const adapter = createStreamAdapter("/repo");
      expect(() => {
        expect(adapter.onStdoutLine("this is not json")).toEqual([]);
        expect(adapter.onStdoutLine('{"type":"syst')).toEqual([]); // truncated JSON
        expect(adapter.onStdoutLine(JSON.stringify({ type: "telepathy" }))).toEqual([]);
        expect(adapter.onStdoutLine(JSON.stringify({ type: "system", subtype: "mystery" }))).toEqual([]);
        expect(adapter.onStdoutLine("")).toEqual([]);
        expect(adapter.onStderrLine("")).toEqual([]);
        expect(adapter.onStdoutChunk('{"type":"syst')).toEqual([]); // stays buffered
      }).not.toThrow();
    });

    it("a tool_result with no matching tool_use emits nothing", () => {
      const state = createAdapterState("/repo");
      expect(
        adaptClaudeMessage(
          {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "ghost", is_error: false }] },
          },
          state,
        ),
      ).toEqual([]);
    });

    it("hook lines are recognized and produce nothing", () => {
      const state = createAdapterState("/repo");
      expect(
        adaptClaudeMessage(
          { type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "SessionStart:startup" },
          state,
        ),
      ).toEqual([]);
      expect(
        adaptClaudeMessage(
          {
            type: "system",
            subtype: "hook_response",
            hook_id: "h1",
            outcome: "success",
            stdout: "{}\n",
          },
          state,
        ),
      ).toEqual([]);
    });

    it("maps a non-success result to RunFailed, preferring terminal_reason", () => {
      const state = createAdapterState("/repo");
      expect(
        adaptClaudeMessage(
          { type: "result", subtype: "error_max_turns", terminal_reason: "max_turns" },
          state,
        ),
      ).toEqual([{ type: "RunFailed", reason: "max_turns", exitCode: 1 }]);
      expect(
        adaptClaudeMessage({ type: "result", subtype: "error_during_execution" }, state),
      ).toEqual([{ type: "RunFailed", reason: "error_during_execution", exitCode: 1 }]);
    });

    it("records the session id from init into the adapter state (H3)", () => {
      const state = createAdapterState("/repo");
      adaptClaudeMessage(
        { type: "system", subtype: "init", session_id: "sess-1", model: "m", tools: ["Read"] },
        state,
      );
      expect(state.sessionId).toBe("sess-1");
    });
  });

  describe("stderr retry sink", () => {
    it("classifies explicit retry notices as ApiRetry, with the attempt when present", () => {
      const adapter = createStreamAdapter("/repo");
      const retry = adapter.onStderrLine("Retrying in 1000ms… (attempt 2/10)");
      expect(retry).toHaveLength(1);
      expect(retry[0]?.type).toBe("ApiRetry");
      expect(JSON.stringify(retry)).toContain('"attempt":2');
      expect(JSON.stringify(retry)).toContain("Retrying");

      const overload = adapter.onStderrLine("API Error: 529 - overloaded_error");
      expect(typesOf(overload)).toEqual(["ApiRetry"]);
    });

    it("structured diagnostics on successful runs are NOT retries (A0)", () => {
      const adapter = createStreamAdapter("/repo");
      expect(
        adapter.onStderrLine('[claude-code:unrecognized_model] {"model":"glm-5.3[1m]"}'),
      ).toEqual([]);
      expect(adapter.onStderrLine("some unrelated warning")).toEqual([]);
    });
  });

  describe("bus integration (architecture: the adapter emits un-stamped EventInput)", () => {
    it("adapter output feeds bus.emit, which stamps seq 1..n and the envelope", () => {
      const events = replayFixture("edit.ndjson");
      const bus = createEventBus("run_adapter_test");
      const stamped = events.map((event) => bus.emit(event));
      expect(stamped.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      expect(stamped.every((e) => e.runId === "run_adapter_test")).toBe(true);
      expect(stamped.every((e) => e.provider === "zai.zcode")).toBe(true);
      // The producer never set envelope fields; only the bus did.
      for (const event of events) {
        expect("seq" in event).toBe(false);
        expect("ts" in event).toBe(false);
      }
    });
  });
});
