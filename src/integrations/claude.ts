import path from "node:path";
import type { ManagedFileChange } from "../project/managed-file.js";
import { removeManagedFile, upsertManagedFile } from "../project/managed-file.js";
import { CLAUDE_MANAGED_BLOCK } from "../templates/claude-block.js";

export function claudeFilePath(projectRoot: string): string {
  return path.join(projectRoot, "CLAUDE.md");
}

/** Upsert the GLM delegation block into <root>\CLAUDE.md without overwriting user content (spec §19–21). */
export function installClaudeIntegration(
  projectRoot: string,
  options: { home?: string; dryRun?: boolean } = {},
): ManagedFileChange {
  return upsertManagedFile({
    file: claudeFilePath(projectRoot),
    block: CLAUDE_MANAGED_BLOCK,
    home: options.home,
    dryRun: options.dryRun,
  });
}

export function removeClaudeIntegration(
  projectRoot: string,
  options: { home?: string; dryRun?: boolean } = {},
): ManagedFileChange {
  return removeManagedFile(claudeFilePath(projectRoot), options.home, options.dryRun);
}
