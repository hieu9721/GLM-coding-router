import path from "node:path";
import type { ManagedFileChange } from "../project/managed-file.js";
import { removeManagedFile, upsertManagedFile } from "../project/managed-file.js";
import { AGENTS_MANAGED_BLOCK } from "../templates/agents-block.js";

export function agentsFilePath(projectRoot: string): string {
  return path.join(projectRoot, "AGENTS.md");
}

/** Upsert the GLM delegation block into <root>\AGENTS.md for Codex (spec §23, §24). */
export function installCodexIntegration(
  projectRoot: string,
  options: { home?: string; dryRun?: boolean } = {},
): ManagedFileChange {
  return upsertManagedFile({
    file: agentsFilePath(projectRoot),
    block: AGENTS_MANAGED_BLOCK,
    home: options.home,
    dryRun: options.dryRun,
  });
}

export function removeCodexIntegration(
  projectRoot: string,
  options: { home?: string; dryRun?: boolean } = {},
): ManagedFileChange {
  return removeManagedFile(agentsFilePath(projectRoot), options.home, options.dryRun);
}
