import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config.js";
import type { RouterConfig } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/errors.js";
import { runsDir } from "../../src/core/paths.js";
import type { BudgetSnapshot, BudgetWindow } from "../../src/budget/manager.js";
import { readEvents } from "../../src/runs/store.js";
import { runInstrumented } from "../../src/runs/worker-run.js";
import type { WorkerRunOptions, WorkerRunResult } from "../../src/runs/worker-run.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

const EDIT_STREAM = fileURLToPath(new URL("../fixtures/streams/edit.ndjson", import.meta.url));

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
});

class MemoryStream extends Writable {
  public isTTY = false;
  private readonly parts: string[] = [];
  public constructor() {
    super({
      write: (chunk: unknown, _e: BufferEncoding, cb: (error?: Error | null) => void): void => {
        this.parts.push(String(chunk));
        cb();
      },
    });
  }
  public text(): string {
    return this.parts.join("");
  }
}

function budgetWindow(ratio: number, limit: number): BudgetWindow {
  const remaining = Math.round(limit * ratio);
  return { used: limit - remaining, limit, remaining, remainingRatio: ratio, resetAt: "2026-09-21T12:00:00.000Z" };
}

/** The 5-hour window carries the ratio; the weekly one stays healthy so the zone is unambiguous. */
function snapshot(ratio: number): BudgetSnapshot {
  return {
    provider: "zai.zcode",
    unit: "credit",
    costClass: "subscription",
    fiveHour: budgetWindow(ratio, 2000),
    weekly: budgetWindow(0.9, 40000),
    confidence: "exact",
    fetchedAt: "2026-09-21T10:00:00.000Z",
  };
}

function configWith(routing: Partial<RouterConfig["routing"]>): RouterConfig {
  const base = defaultConfig();
  return { ...base, routing: { ...base.routing, ...routing } };
}

/** A repo with one committed file, one tracked edit, and one untracked file. */
function makeRepoWithWork(): string {
  const repo = makeTempDir("glm-drain-cwd-");
  dirs.push(repo);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "tracked.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "tracked.ts"), "export const a = 2;\n");
  fs.writeFileSync(path.join(repo, "untracked.ts"), "export const b = 3;\n");
  return repo;
}

const STREAM_LINES = fs
  .readFileSync(EDIT_STREAM, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.length > 0);

interface Outcome {
  readonly result: WorkerRunResult;
  readonly stdout: MemoryStream;
  readonly stderr: MemoryStream;
  readonly home: string;
  /** Signals the fake child received, in order — the termination ladder, observed. */
  readonly signals: string[];
  /** How many stream lines were fed before the child was stopped. */
  readonly linesFed: number;
}

/**
 * Replays a captured stream as the "child", with the drain poll under the
 * test's control: no real timer, no real quota, no real process.
 *
 * `dropAtLine` is where the budget collapses. Firing the poll schedules an
 * async assessment, so the replay yields a macrotask afterwards — without that
 * the synchronous line loop would finish before the router ever learned the
 * quota had moved, and the test would prove nothing.
 */
async function runScenario(opts: {
  readonly budget: () => BudgetSnapshot;
  readonly config?: RouterConfig;
  readonly cwd?: string;
  /** Fire the drain poll after this many lines have been fed. */
  readonly dropAtLine?: number;
  /** Drop the terminal `result` line: the child died before finishing. */
  readonly truncateTerminal?: boolean;
  readonly childExitCode?: number;
}): Promise<Outcome> {
  const home = makeTempDir("glm-drain-home-");
  dirs.push(home);
  const cwd = opts.cwd ?? makeTempDir("glm-drain-plain-");
  if (opts.cwd === undefined) dirs.push(cwd);

  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const signals: string[] = [];
  let poll: (() => void) | undefined;
  let linesFed = 0;

  const lines = opts.truncateTerminal === true ? STREAM_LINES.slice(0, -1) : STREAM_LINES;

  const spawnImpl: WorkerRunOptions["spawnImpl"] = async (_bin, spawnOpts) => {
    let killed = false;
    const child = {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal: string): boolean {
        signals.push(signal);
        killed = true;
        // A real child exits on SIGINT; modelling that stops the ladder there,
        // which is what the production path should see on a cooperative child.
        child.exitCode = 143;
        return true;
      },
    };
    spawnOpts.onSpawn?.(child as unknown as Parameters<NonNullable<typeof spawnOpts.onSpawn>>[0]);

    for (const [index, line] of lines.entries()) {
      if (killed) {
        break;
      }
      if (index === opts.dropAtLine) {
        poll?.();
        await new Promise((resolve) => setImmediate(resolve));
      }
      spawnOpts.onStdoutLine?.(line);
      linesFed += 1;
    }
    return { code: killed ? 143 : (opts.childExitCode ?? 0) };
  };

  const result = await runInstrumented({
    kind: "worker",
    prompt: "Add validation to the parser",
    args: ["fake", "-p", "Add validation to the parser", "--max-turns", "20"],
    claudePath: process.execPath,
    config: opts.config ?? defaultConfig(),
    secrets: [],
    cwd,
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3" },
    home,
    stdout,
    stderr,
    spawnImpl,
    budgetSource: async () => opts.budget(),
    activeRunCount: () => 1,
    setIntervalImpl: (tick) => {
      poll = tick;
      return {};
    },
    clearIntervalImpl: () => {},
  });

  return { result, stdout, stderr, home, signals, linesFed };
}

function runDirOf(home: string): string {
  const history = path.join(runsDir(home), "history");
  const date = fs.readdirSync(history)[0];
  const id = fs.readdirSync(path.join(history, date))[0];
  return path.join(history, date, id);
}

describe("bundle-on-death — the guarantee that holds with EVERY switch off", () => {
  it("a child that dies after touching files leaves a bundle, and the exit stays 40", async () => {
    // The real quota-exhaustion shape: the child fails on an API error. At that
    // moment the work is invisible to the orchestrator unless someone writes it
    // down — which is why this path does not depend on any switch.
    const repo = makeRepoWithWork();
    const outcome = await runScenario({
      cwd: repo,
      budget: () => snapshot(0.8),
      truncateTerminal: true,
      childExitCode: 1,
    });

    expect(outcome.result.code).toBe(ExitCode.ChildAgentFailed);
    expect(outcome.result.code).toBe(40);

    const handoffDir = path.join(runDirOf(outcome.home), "handoff");
    expect(fs.existsSync(path.join(handoffDir, "handoff.md"))).toBe(true);
    expect(fs.existsSync(path.join(handoffDir, "handoff.json"))).toBe(true);
    expect(fs.existsSync(path.join(handoffDir, "checkpoint.json"))).toBe(true);
    // The edits are really in the patch, not merely claimed to be.
    expect(fs.readFileSync(path.join(handoffDir, "diff.patch"), "utf8")).toContain("export const a = 2;");
    // ...and the untracked file, which no patch can carry, is named separately.
    expect(fs.readFileSync(path.join(handoffDir, "handoff.md"), "utf8")).toContain("untracked.ts");

    // A breadcrumb on stderr; stdout stays the C1 channel, no handoff protocol.
    expect(outcome.stderr.text()).toContain("handoff bundle:");
    expect(outcome.stdout.text()).not.toContain("handoff_required");
  });

  it("a clean success writes no bundle at all", async () => {
    const outcome = await runScenario({ budget: () => snapshot(0.8) });

    expect(outcome.result.code).toBe(ExitCode.Success);
    expect(fs.existsSync(path.join(runDirOf(outcome.home), "handoff"))).toBe(false);
  });
});

describe("drain with handoffOnLowQuota OFF — the shipped 2.0.0 default (D3)", () => {
  it("a collapsing quota warns and checkpoints, but never signals the child", async () => {
    // Every assertion here has a positive half and a negative half on purpose:
    // asserting only "no signal" would pass just as happily if the drain had
    // never run at all, which is exactly how a test ends up proving nothing.
    let ratio = 0.8;
    const outcome = await runScenario({
      budget: () => {
        const current = snapshot(ratio);
        ratio = 0.01; // every reading after the first is CRITICAL
        return current;
      },
      dropAtLine: 20,
    });

    // Positive: the drain DID fire.
    const types = readEvents(runDirOf(outcome.home)).map((event) => event.type);
    expect(types).toContain("BudgetWarning");
    expect(fs.existsSync(path.join(runDirOf(outcome.home), "checkpoint.json"))).toBe(true);
    expect(outcome.stderr.text()).toContain("[Router]");

    // Negative: and it did the one thing D3 forbids — nothing.
    expect(outcome.signals).toEqual([]);
    expect(outcome.result.code).toBe(ExitCode.Success);
    expect(outcome.stdout.text()).not.toContain("handoff_required");
    expect(types).not.toContain("HandoffStarted");
  });
});

describe("drain with handoffOnLowQuota ON — exit 42 at a safe boundary", () => {
  it("stops the child, writes the bundle, and puts the HandoffResult on stdout", async () => {
    const repo = makeRepoWithWork();
    let ratio = 0.8;
    const outcome = await runScenario({
      cwd: repo,
      config: configWith({ handoffOnLowQuota: true }),
      budget: () => {
        const current = snapshot(ratio);
        ratio = 0.01;
        return current;
      },
      // Line 72 of this fixture sits BETWEEN a tool_use (71) and its
      // tool_result (73) — a tool is in flight, so the router is not allowed
      // to stop here and must wait for the boundary. Dropping at a quiet line
      // instead would let the immediate path answer and prove nothing about
      // the boundary at all (it did, until a mutation test caught it).
      dropAtLine: 72,
    });

    expect(outcome.result.code).toBe(ExitCode.HandoffRequired);
    expect(outcome.result.code).toBe(42);
    // The ladder opens with SIGINT — never a forced kill, which is what would
    // cost the work this whole path exists to save.
    expect(outcome.signals[0]).toBe("SIGINT");
    // It stopped early: the replay never reached the end of the stream.
    expect(outcome.linesFed).toBeLessThan(STREAM_LINES.length);

    // stdout is the HandoffResult and nothing else (C1's handoff exception).
    const parsed = JSON.parse(outcome.stdout.text()) as {
      status: string;
      run_id: string;
      reason: string;
      handoff_path: string | null;
      pending: string[];
    };
    expect(parsed.status).toBe("handoff_required");
    expect(parsed.reason).toContain("quota_low");
    expect(parsed.run_id).toBe(outcome.result.runId);
    expect(parsed.handoff_path).toContain("handoff.md");
    expect(parsed.pending.length).toBeGreaterThan(0);

    // The events tell the same story the exit code does.
    const types = readEvents(runDirOf(outcome.home)).map((event) => event.type);
    expect(types).toContain("BudgetWarning");
    expect(types).toContain("CheckpointCreated");

    // THE safe-boundary assertion: whatever the router did, it did it right
    // after a tool closed or a turn began — never with a tool still open.
    const boundary = types[types.indexOf("CheckpointCreated") - 1];
    expect(["ToolCompleted", "ToolDenied", "TurnStarted"]).toContain(boundary);
    expect(types).toContain("HandoffStarted");
    expect(types).toContain("HandoffCompleted");
    // Handoff is a distinct outcome, not a cancellation — a parent has to be
    // able to tell "the router stepped in" from "the human pressed Ctrl+C".
    expect(types).not.toContain("RunCancelled");

    // And the point of all of it: the worktree still holds the work.
    expect(fs.readFileSync(path.join(repo, "tracked.ts"), "utf8")).toContain("export const a = 2;");
    expect(fs.existsSync(path.join(repo, "untracked.ts"))).toBe(true);
  });
});
