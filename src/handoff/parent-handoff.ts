import { ExitCode } from "../core/errors.js";
import { logger } from "../core/logging.js";

/**
 * The doc §18 contract an orchestrator parses off stdout. Snake_case on
 * purpose: this shape crosses a process boundary into Claude/Codex, and the
 * doc spells it this way — the rest of the codebase's camelCase stops at the
 * pipe.
 */
export interface HandoffResult {
  readonly status: "handoff_required";
  readonly run_id: string;
  /** `quota_insufficient` (preflight, 41) or `quota_low` / a drain reason (mid-run, 42). */
  readonly reason: string;
  readonly completed: readonly string[];
  readonly pending: readonly string[];
  /** Where the bundle is; null when nothing was spawned, so nothing was produced. */
  readonly handoff_path: string | null;
  /** Preflight refusals carry the arithmetic that caused them. */
  readonly estimated_cost?: number;
  readonly usable_quota?: number;
}

/**
 * Emit a handoff to the parent session and return its exit code (D2).
 *
 * **stdout carries the JSON and nothing else.** Contract C1 reserves stdout
 * for the run's final answer, and a handed-off run has none — it did not
 * finish. Printing a partial answer next to the JSON would give an
 * orchestrator two things to parse and no way to tell which is authoritative,
 * so the JSON *is* the output of a run that ends this way.
 *
 * 41 and 42 differ only in what already happened: 41 is a preflight refusal
 * that spawned nothing, 42 a live run stopped at a safe boundary with its work
 * preserved in a bundle. Neither is a crash, which is exactly what the
 * orchestrator templates now say.
 */
export function writeHandoffResult(
  streams: {
    readonly stdout: { write(text: string): void };
    readonly stderr: { write(text: string): void };
  },
  result: HandoffResult,
  humanSummary: readonly string[],
  exitCode: number = ExitCode.HandoffRequired,
): number {
  streams.stdout.write(JSON.stringify(result) + "\n");
  try {
    streams.stderr.write(humanSummary.join("\n") + "\n");
  } catch (error) {
    // The machine-readable half already landed; losing the prose must not
    // change the exit code the parent reads.
    logger.debug(`parent handoff: writing the human summary failed: ${errorMessage(error)}`);
  }
  return exitCode;
}

/** The `[Router]` block a human reads on stderr when a live run hands off (doc §14, §18). */
export function handoffSummaryLines(input: {
  readonly runId: string;
  readonly reason: string;
  readonly bundlePath: string | null;
  readonly completed: readonly string[];
  readonly pending: readonly string[];
}): string[] {
  const lines = [
    `[Router] handing the task back to the parent session (${input.reason}).`,
    `[Router] run ${input.runId} stopped at a safe boundary; its work is on disk.`,
  ];
  if (input.completed.length > 0) {
    lines.push("[Router] done so far:", ...input.completed.map((entry) => `[Router]   ${entry}`));
  }
  if (input.pending.length > 0) {
    lines.push("[Router] still to do:", ...input.pending.map((entry) => `[Router]   ${entry}`));
  }
  lines.push(
    input.bundlePath === null
      ? "[Router] no bundle was written (nothing had changed on disk yet)."
      : `[Router] bundle: ${input.bundlePath}`,
    "[Router] continue in the SAME worktree; do not re-run the worker until quota resets.",
  );
  return lines;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
