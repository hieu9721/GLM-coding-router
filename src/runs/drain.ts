import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import type { RouterConfig } from "../core/config.js";
import { logger } from "../core/logging.js";
import { zoneFor } from "../budget/manager.js";
import type { BudgetSnapshot, BudgetZone } from "../budget/manager.js";
import type { CostEstimate } from "../budget/estimator.js";
import { usableBudgetOf } from "../routing/glm-routing.js";

/**
 * Grace between SIGINT and SIGTERM. Five seconds is enough for `claude` to
 * finish flushing the tool result it is holding and exit on its own — the
 * point of the ladder is to let it close cleanly, not to win a race.
 */
export const TERMINATE_GRACE_MS = 5_000;

/** Second grace, before Windows' last resort. Short: by now it has ignored two signals. */
export const TASKKILL_GRACE_MS = 2_000;

/** Worst-to-best, so "at or below HANDOFF_READY" is one comparison. */
const ZONE_SEVERITY: Record<BudgetZone, number> = {
  CRITICAL: 3,
  HANDOFF_READY: 2,
  CONSERVE: 1,
  HEALTHY: 0,
};

export interface DrainAssessment {
  readonly zone: BudgetZone;
  readonly usableBudget: number;
  /** p90 × safetyFactor × the fraction of the turn budget still unspent. */
  readonly projectedCost: number;
  /** Zone is at or below HANDOFF_READY AND the projection no longer fits. */
  readonly atRisk: boolean;
}

/**
 * Should this run be worried yet? (specs/v2-architecture.md Phase F.)
 *
 * Pure: the caller does the polling and owns every side effect. Note what this
 * projects — the cost of what is LEFT, not of the whole task. A run three
 * quarters done needs a quarter of the estimate, and treating it as if it were
 * starting over would raise the alarm on every long run that is nearly
 * finished, which is precisely when interrupting costs the most.
 *
 * `confidence: "unknown"` can never reach `atRisk`, because `zoneFor` fails
 * open to HEALTHY — a monitoring outage must not drain a live child.
 */
export function assessDrain(input: {
  readonly snapshot: BudgetSnapshot;
  readonly estimate: CostEstimate;
  readonly config: RouterConfig;
  readonly turnsDone: number;
  readonly maxTurns: number;
}): DrainAssessment {
  const routing = input.config.routing;
  const zone = zoneFor(input.snapshot, routing);
  const usableBudget = usableBudgetOf(input.snapshot, routing.reserveRatio);

  // A run that has already used every turn it was given has nothing left to
  // project; an unknown/zero ceiling means "assume it all still lies ahead".
  const remainingTurnRatio =
    input.maxTurns > 0
      ? Math.min(1, Math.max(0, (input.maxTurns - input.turnsDone) / input.maxTurns))
      : 1;
  const projectedCost = input.estimate.p90 * routing.safetyFactor * remainingTurnRatio;

  return {
    zone,
    usableBudget,
    projectedCost,
    atRisk: ZONE_SEVERITY[zone] >= ZONE_SEVERITY.HANDOFF_READY && projectedCost > usableBudget,
  };
}

export interface DrainWatchHandle {
  stop(): void;
}

/**
 * Polls the budget while the child runs and calls back the first time the run
 * becomes at-risk, then never again: the warning and the checkpoint are worth
 * writing once, and a per-poll repeat would turn a tight quota into a wall of
 * identical stderr lines.
 *
 * Every timer is injectable because a test must not wait a real minute, and
 * the interval is unref'd so a poll in flight can never hold the process open
 * past the run it was watching.
 */
export function startDrainWatch(input: {
  readonly config: RouterConfig;
  readonly readBudget: () => Promise<BudgetSnapshot>;
  readonly estimate: () => CostEstimate;
  readonly turnsDone: () => number;
  readonly maxTurns: number;
  readonly onAtRisk: (assessment: DrainAssessment) => void;
  readonly setIntervalImpl?: (tick: () => void, ms: number) => { unref?: () => void };
  readonly clearIntervalImpl?: (handle: unknown) => void;
}): DrainWatchHandle {
  const setIntervalFn = input.setIntervalImpl ?? ((tick, ms) => setInterval(tick, ms));
  const clearIntervalFn = input.clearIntervalImpl ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let fired = false;
  let stopped = false;

  const tick = (): void => {
    if (fired || stopped) {
      return;
    }
    // Fire-and-forget: a poll that rejects must not become an unhandled
    // rejection, and a slow endpoint must not delay the next tick.
    void (async () => {
      try {
        const assessment = assessDrain({
          snapshot: await input.readBudget(),
          estimate: input.estimate(),
          config: input.config,
          turnsDone: input.turnsDone(),
          maxTurns: input.maxTurns,
        });
        if (assessment.atRisk && !fired && !stopped) {
          fired = true;
          input.onAtRisk(assessment);
        }
      } catch (error) {
        logger.debug(`drain watch: poll failed, continuing: ${errorMessage(error)}`);
      }
    })();
  };

  const handle = setIntervalFn(tick, Math.max(1, input.config.routing.pollIntervalSec) * 1000);
  handle.unref?.();

  return {
    stop(): void {
      stopped = true;
      clearIntervalFn(handle);
    },
  };
}

/**
 * Stop the child at a safe boundary: SIGINT, grace, SIGTERM, and on Windows
 * `taskkill /pid <pid> /t` as the last resort — the same ladder and the same
 * no-shell rule the spawn helpers already follow.
 *
 * Windows has no real POSIX signals: Node emulates `kill` by terminating the
 * process, and a `claude` that spawned its own children leaves them behind,
 * which is what `/t` (kill the tree) is for. `/f` is deliberately NOT used
 * before the tree walk — a forced kill is the thing this whole ladder exists
 * to avoid, because it is what loses the work on disk.
 *
 * Resolves when the child is gone or the ladder is exhausted; never throws.
 */
export async function terminateChild(
  child: ChildProcess,
  options: {
    readonly graceMs?: number;
    readonly taskkillGraceMs?: number;
    readonly platform?: NodeJS.Platform;
    readonly runTaskkill?: (pid: number) => void;
    readonly waitImpl?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const wait = options.waitImpl ?? defaultWait;
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;

  send(child, "SIGINT");
  if (exited()) {
    return;
  }
  await wait(options.graceMs ?? TERMINATE_GRACE_MS);
  if (exited()) {
    return;
  }

  send(child, "SIGTERM");
  if (platform !== "win32") {
    return;
  }
  await wait(options.taskkillGraceMs ?? TASKKILL_GRACE_MS);
  if (exited() || typeof child.pid !== "number") {
    return;
  }
  const taskkill = options.runTaskkill ?? defaultTaskkill;
  try {
    taskkill(child.pid);
  } catch (error) {
    logger.debug(`terminateChild: taskkill failed: ${errorMessage(error)}`);
  }
}

/** A kill on an already-dead child throws ESRCH; that is success, not an error. */
function send(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (error) {
    logger.debug(`terminateChild: ${signal} failed: ${errorMessage(error)}`);
  }
}

/** argv array, no shell — the same rule every spawn in this package follows. */
function defaultTaskkill(pid: number): void {
  execFile("taskkill", ["/pid", String(pid), "/t"], { windowsHide: true }, (error) => {
    if (error) {
      logger.debug(`taskkill /pid ${pid} /t failed: ${error.message}`);
    }
  });
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // unref: a pending grace period must never keep the process alive.
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
