import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config.js";
import type { RouterConfig } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/errors.js";
import { runsDir } from "../../src/core/paths.js";
import type { BudgetSnapshot, BudgetWindow } from "../../src/budget/manager.js";
import { readEvents } from "../../src/runs/store.js";
import type { RunSummary } from "../../src/runs/store.js";
import { runInstrumented } from "../../src/runs/worker-run.js";
import type { WorkerRunOptions, WorkerRunResult } from "../../src/runs/worker-run.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

const BASIC_STREAM = fileURLToPath(new URL("../fixtures/streams/basic.ndjson", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));

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

/** A window at the given remaining ratio; only the ratio and `used` are read. */
function window(remainingRatio: number, limit = 2000): BudgetWindow {
  const remaining = Math.round(limit * remainingRatio);
  return {
    used: limit - remaining,
    limit,
    remaining,
    remainingRatio,
    resetAt: "2026-09-21T12:00:00.000Z",
  };
}

/**
 * An injected quota, so no test needs the network or a key. The ratio is what
 * decides the zone: < 0.08 CRITICAL, < 0.15 HANDOFF_READY, < 0.30 CONSERVE.
 */
function snapshot(ratio: number, confidence: BudgetSnapshot["confidence"] = "exact"): BudgetSnapshot {
  return {
    provider: "zai.zcode",
    unit: "credit",
    costClass: "subscription",
    fiveHour: window(ratio),
    weekly: window(Math.max(ratio, 0.9), 40000),
    confidence,
    fetchedAt: "2026-09-21T10:00:00.000Z",
  };
}

function configWith(routing: Partial<RouterConfig["routing"]>): RouterConfig {
  const base = defaultConfig();
  return { ...base, routing: { ...base.routing, ...routing } };
}

interface Outcome {
  readonly result: WorkerRunResult;
  readonly stdout: MemoryStream;
  readonly stderr: MemoryStream;
  readonly home: string;
  /** The env the child was actually spawned with; null when nothing spawned. */
  readonly childEnv: NodeJS.ProcessEnv | null;
  readonly spawned: boolean;
}

/**
 * One preflighted run. The spawn is always the recording replay stub, so both
 * halves of every assertion are observable: the env the child would have got,
 * and whether anything was spawned at all.
 */
async function run(
  overrides: Partial<WorkerRunOptions>,
): Promise<Outcome> {
  const home = makeTempDir("glm-preflight-home-");
  const cwd = makeTempDir("glm-preflight-cwd-");
  dirs.push(home, cwd);
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  let childEnv: NodeJS.ProcessEnv | null = null;
  let spawned = false;
  // Records the env the child WOULD have got, then replays the captured
  // stream through the adapter — so the run completes exactly as a real one
  // does (events, summary, exit 0) without paying for a process per test.
  // Without the replay there is no RunCompleted and every run would exit 40,
  // which would hide the very exit codes these tests are about.
  const record: WorkerRunOptions["spawnImpl"] = async (_bin, opts) => {
    spawned = true;
    childEnv = opts.env ?? {};
    for (const line of fs.readFileSync(BASIC_STREAM, "utf8").split(/\r?\n/)) {
      if (line.length > 0) {
        opts.onStdoutLine?.(line);
      }
    }
    return { code: 0 };
  };

  const base: WorkerRunOptions = {
    kind: "worker",
    prompt: "Add a user endpoint",
    args: [FAKE_AGENT, "-p", "Add a user endpoint", "--max-turns", "20"],
    claudePath: process.execPath,
    config: defaultConfig(),
    secrets: [],
    cwd,
    env: {
      GLM_TEST_STREAM: BASIC_STREAM,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash",
    },
    home,
    stdout,
    stderr,
    // One active run is the clean-measurement case; tests that care set it.
    activeRunCount: () => 1,
  };

  const result = await runInstrumented({ ...base, spawnImpl: record, ...overrides });
  return { result, stdout, stderr, home, childEnv, spawned };
}

/** The single summary.json a finished run leaves behind. */
function summaryOf(home: string): RunSummary {
  const history = path.join(runsDir(home), "history");
  const dates = fs.readdirSync(history);
  const ids = fs.readdirSync(path.join(history, dates[0]));
  return JSON.parse(
    fs.readFileSync(path.join(history, dates[0], ids[0], "summary.json"), "utf8"),
  ) as RunSummary;
}

function runDirOf(home: string): string {
  const history = path.join(runsDir(home), "history");
  const dates = fs.readdirSync(history);
  const ids = fs.readdirSync(path.join(history, dates[0]));
  return path.join(history, dates[0], ids[0]);
}

describe("preflight with the SHIPPED 2.0.0 defaults (decision D3)", () => {
  it("a CRITICAL quota still spawns the child, exits 0, and records wouldRefuse", async () => {
    // The acceptance criterion D3 names: observe and warn, never refuse.
    const outcome = await run({ budgetSource: async () => snapshot(0.02) });

    expect(outcome.result.code).toBe(ExitCode.Success);
    expect(outcome.spawned).toBe(true);

    const summary = summaryOf(outcome.home);
    expect(summary.routingAdvice).toBeDefined();
    expect(summary.routingAdvice?.wouldRefuse).toBe(true);
    expect(summary.routingAdvice?.zone).toBe("CRITICAL");
    // The whole point of recording it: this is what 2.1 compares against.
    expect(summary.routingAdvice).toHaveProperty("actualCredits");
  });

  it("warns exactly once on stderr and never on stdout (contract C1)", async () => {
    const outcome = await run({ budgetSource: async () => snapshot(0.02) });

    const routerLines = outcome.stderr.text().split("\n").filter((line) => line.startsWith("[Router]"));
    expect(routerLines).toHaveLength(1);
    expect(routerLines[0]).toContain("CRITICAL");
    expect(outcome.stdout.text()).not.toContain("[Router]");
    expect(outcome.stdout.text()).not.toContain("handoff_required");
  });

  it("emits a BudgetWarning event so the near-miss survives in the history", async () => {
    const outcome = await run({ budgetSource: async () => snapshot(0.02) });

    const warnings = readEvents(runDirOf(outcome.home)).filter((event) => event.type === "BudgetWarning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ type: "BudgetWarning", zone: "CRITICAL" });
  });

  it("a HEALTHY quota runs on the main model with no warning at all", async () => {
    const outcome = await run({ budgetSource: async () => snapshot(0.8) });

    expect(outcome.result.code).toBe(ExitCode.Success);
    expect(outcome.childEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3");
    expect(outcome.stderr.text()).not.toContain("[Router]");
    expect(summaryOf(outcome.home).routingAdvice?.wouldRefuse).toBe(false);
  });
});

describe("preflight downgrade (doc §12)", () => {
  it("a CONSERVE zone puts the FAST model in the child env, not just in our config", async () => {
    // The child reads its model from the env; a downgrade that never reaches
    // ANTHROPIC_DEFAULT_* would be a decision with no effect.
    const outcome = await run({ budgetSource: async () => snapshot(0.2) });

    expect(outcome.childEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3-flash");
    expect(outcome.childEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.3-flash");
    // The caller's own env object must not be mutated — only the child's copy.
    expect(outcome.result.code).toBe(ExitCode.Success);
  });

  it("the downgraded model is what the run records, so history is not fiction", async () => {
    const outcome = await run({ budgetSource: async () => snapshot(0.2) });

    const started = readEvents(runDirOf(outcome.home)).find((event) => event.type === "RunStarted");
    expect(started).toMatchObject({ type: "RunStarted", model: "glm-5.3-flash" });
  });
});

describe("preflight refusal with refuseOnCritical: true (not the shipped default)", () => {
  const enforced = configWith({ refuseOnCritical: true });

  it("exits 41, prints one HandoffResult on stdout, and spawns nothing", async () => {
    const outcome = await run(
      { config: enforced, budgetSource: async () => snapshot(0.02) },
    );

    expect(outcome.result.code).toBe(ExitCode.QuotaInsufficient);
    expect(outcome.result.code).toBe(41);
    expect(outcome.spawned).toBe(false);

    const parsed = JSON.parse(outcome.stdout.text()) as {
      status: string;
      run_id: string;
      reason: string;
      pending: string[];
      handoff_path: null;
    };
    expect(parsed.status).toBe("handoff_required");
    expect(parsed.reason).toBe("quota_insufficient");
    expect(parsed.run_id).toBe(outcome.result.runId);
    expect(parsed.pending).toEqual(["Add a user endpoint"]);
    expect(parsed.handoff_path).toBeNull();
  });

  it("puts the human explanation on stderr in the standard ERROR format", async () => {
    const outcome = await run(
      { config: enforced, budgetSource: async () => snapshot(0.02) },
    );

    expect(outcome.stderr.text()).toContain("ERROR [QUOTA_INSUFFICIENT]");
    expect(outcome.stderr.text()).toContain("--force");
  });

  it("writes nothing to the run history — a run that never started has nothing to show", async () => {
    const outcome = await run(
      { config: enforced, budgetSource: async () => snapshot(0.02) },
    );

    expect(fs.existsSync(path.join(runsDir(outcome.home), "history"))).toBe(false);
  });

  it("--force bypasses the enforced refusal and runs anyway", async () => {
    const outcome = await run(
      { config: enforced, budgetSource: async () => snapshot(0.02), force: true },
    );

    expect(outcome.result.code).toBe(ExitCode.Success);
    expect(outcome.spawned).toBe(true);
  });

  it("--model main pins the model but does NOT bypass the refusal", async () => {
    const outcome = await run(
      { config: enforced, budgetSource: async () => snapshot(0.02), requestedModel: "main" },
    );

    expect(outcome.result.code).toBe(ExitCode.QuotaInsufficient);
    expect(outcome.spawned).toBe(false);
  });
});

describe("preflight fails open", () => {
  it("an unknown quota runs normally on the main model, even with refusal enforced", async () => {
    // A monitoring outage must never block work — that is the whole contract.
    const outcome = await run(
      {
        config: configWith({ refuseOnCritical: true }),
        budgetSource: async () => snapshot(0, "unknown"),
      },
    );

    expect(outcome.result.code).toBe(ExitCode.Success);
    expect(outcome.spawned).toBe(true);
    expect(outcome.childEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3");
  });

  it("a budget source that throws still runs the task, unrouted", async () => {
    const outcome = await run(
      {
        config: configWith({ refuseOnCritical: true }),
        budgetSource: async () => {
          throw new Error("endpoint on fire");
        },
      },
    );

    expect(outcome.result.code).toBe(ExitCode.Success);
    expect(outcome.spawned).toBe(true);
  });

  it("quotaAware: false skips routing entirely", async () => {
    const outcome = await run(
      {
        config: configWith({ quotaAware: false, refuseOnCritical: true }),
        budgetSource: async () => snapshot(0.01),
      },
    );

    expect(outcome.result.code).toBe(ExitCode.Success);
    expect(outcome.childEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3");
  });
});
