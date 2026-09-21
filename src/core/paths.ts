import os from "node:os";
import path from "node:path";

/** Config directory: %USERPROFILE%\.glm-coding-router (spec §13). */
export function configDir(home: string = os.homedir()): string {
  return path.join(home, ".glm-coding-router");
}

export function configPath(home: string = os.homedir()): string {
  return path.join(configDir(home), "config.json");
}

/** Local metadata tracking which project files this tool created entirely (spec §43). */
export function ownershipPath(home: string = os.homedir()): string {
  return path.join(configDir(home), "ownership.json");
}

/** Run history root: <configDir>/runs (specs/v2-architecture.md, Phase B). */
export function runsDir(home: string = os.homedir()): string {
  return path.join(configDir(home), "runs");
}

/** Registry of still-running workers; a run graduates to history on finish. */
export function activeRunsDir(home: string = os.homedir()): string {
  return path.join(runsDir(home), "active");
}

/**
 * History partitioned per day so retention can prune whole date directories
 * (doc §6). `date` (YYYY-MM-DD) comes from the caller — no clock inside the
 * path helpers, so the store decides when the day flips.
 */
export function runHistoryDir(home: string = os.homedir(), date: string): string {
  return path.join(runsDir(home), "history", date);
}

/** One directory per run: events.jsonl, summary.json, checkpoint, handoff bundle. */
export function runDir(home: string = os.homedir(), date: string, id: string): string {
  return path.join(runHistoryDir(home, date), id);
}

/** The registry entry for an active run, deleted when the run moves to history. */
export function activeRunFile(home: string = os.homedir(), id: string): string {
  return path.join(activeRunsDir(home), `${id}.json`);
}

/** Cached quota snapshot (specs/v2-architecture.md, Phase E) — a cache, never truth. */
export function quotaCachePath(home: string = os.homedir()): string {
  return path.join(configDir(home), "cache", "quota.json");
}

/** Cost-history samples, one JSON line per cleanly measured run (doc §13, Phase E). */
export function costSamplesPath(home: string = os.homedir()): string {
  return path.join(configDir(home), "cost-samples.jsonl");
}
