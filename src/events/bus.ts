import { logger } from "../core/logging.js";
import type { AgentRole, ProviderId, WorkerEvent } from "./types.js";

/**
 * `Omit` does not distribute over unions — applied to `WorkerEvent` directly
 * it would collapse every event into one object holding only the shared keys,
 * and the `type` discriminant would be lost. Distributing first keeps one
 * input shape per event.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A `WorkerEvent` minus the six envelope fields the bus stamps. Producers
 * physically cannot set them, so sequence numbers cannot be forged and the
 * persisted stream is orderable by construction.
 */
export type EventInput = DistributiveOmit<
  WorkerEvent,
  "runId" | "taskId" | "provider" | "role" | "seq" | "ts"
>;

/**
 * The dispatch hub every v2 consumer hangs off (store, renderer, checkpoint,
 * drain controller). Consumers depend on this interface, never on Claude's
 * stream shapes (hedge H8) — a second provider adapter plugs into the same
 * bus untouched.
 */
export interface EventBus {
  readonly runId: string;
  readonly taskId: string;
  emit(event: EventInput): WorkerEvent;
  subscribe(listener: (event: WorkerEvent) => void): () => void;
  close(): void;
}

/**
 * Not a `createEventBus` parameter: v2 has exactly one provider, and a
 * parameter would invite a wrong value into the persisted history (H2).
 */
const PROVIDER: ProviderId = "zai.zcode";

/**
 * Build a bus for one run. `taskId` defaults to the `runId` while there is no
 * task graph (hedge H1); `role` defaults to `"worker"`. `deps.now` exists so
 * tests can pin `ts` deterministically; production omits it and gets the real
 * clock.
 */
export function createEventBus(
  runId: string,
  deps?: { taskId?: string; role?: AgentRole; now?: () => Date },
): EventBus {
  const taskId = deps?.taskId ?? runId;
  const role = deps?.role ?? "worker";
  const now = deps?.now;
  const listeners = new Set<(event: WorkerEvent) => void>();
  let seq = 0;
  let closed = false;

  return {
    runId,
    taskId,
    emit(event: EventInput): WorkerEvent {
      const stamped = {
        ...event,
        runId,
        taskId,
        provider: PROVIDER,
        role,
        seq: ++seq,
        ts: (now?.() ?? new Date()).toISOString(),
      };
      if (!closed) {
        for (const listener of listeners) {
          try {
            listener(stamped);
          } catch (error) {
            // A broken renderer must never kill a run (specs/v2-architecture.md,
            // Phase A): swallow, keep dispatching, leave a debug trace.
            logger.debug(
              `event subscriber threw on ${stamped.type} seq ${stamped.seq}: ${errorMessage(error)}`,
            );
          }
        }
      }
      return stamped;
    },
    subscribe(listener: (event: WorkerEvent) => void): () => void {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close(): void {
      closed = true;
      listeners.clear();
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
