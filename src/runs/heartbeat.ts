import type { EventBus } from "../events/bus.js";
import { logger } from "../core/logging.js";
import { updateRun } from "./registry.js";
import type { RunState } from "./registry.js";

/**
 * Doc §6 fixes the tick at 5 s and keeps it out of config on purpose: the
 * 30 s orphan threshold is six missed ticks of THIS interval. A config knob
 * here would let anyone silently break liveness detection.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

/** The minimum a heartbeat needs from its timer; `unref` is optional because not every runtime has it. */
export interface TimerLike {
  unref?(): void;
}

export interface HeartbeatDeps {
  readonly bus: EventBus;
  readonly home: string;
  readonly runId: string;
  readonly getState: () => RunState;
  readonly getTurn: () => number;
  readonly intervalMs?: number;
  /** Injectable so tests never start a real timer; defaults to `setInterval`. */
  readonly setIntervalImpl?: (tick: () => void, intervalMs: number) => TimerLike;
  readonly clearIntervalImpl?: (timer: TimerLike) => void;
}

export interface HeartbeatHandle {
  /** Stops ticking. Idempotent. */
  stop(): void;
}

/**
 * Emits a `Heartbeat` event and refreshes `heartbeatAt` in the active file on
 * every tick — the pair that `watch` and orphan detection read. A file
 * failure is caught and logged at debug: the heartbeat is liveness plumbing,
 * and plumbing must never kill the run it is monitoring. The bus's own
 * subscriber guard covers the emit side.
 */
export function startHeartbeat(deps: HeartbeatDeps): HeartbeatHandle {
  const intervalMs = deps.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const tick = (): void => {
    deps.bus.emit({ type: "Heartbeat", state: deps.getState(), turn: deps.getTurn() });
    try {
      updateRun(deps.home, deps.runId, { heartbeatAt: new Date().toISOString() });
    } catch (error) {
      logger.debug(`heartbeat: could not refresh ${deps.runId}: ${errorMessage(error)}`);
    }
  };

  const setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl =
    deps.clearIntervalImpl ?? ((timer: TimerLike) => clearInterval(timer as NodeJS.Timeout));
  let timer: TimerLike | null = setIntervalImpl(tick, intervalMs);
  // Unref when the runtime supports it: a leaked heartbeat timer must never
  // be the reason the process stays open after the run finished.
  timer.unref?.();

  return {
    stop(): void {
      if (timer === null) {
        return;
      }
      clearIntervalImpl(timer);
      timer = null;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
