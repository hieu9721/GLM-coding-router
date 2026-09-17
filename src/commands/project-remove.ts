import { findProjectRoot } from "../project/project-root.js";
import { removeClaudeIntegration } from "../integrations/claude.js";
import { removeCodexIntegration } from "../integrations/codex.js";
import type { ManagedFileChange } from "../project/managed-file.js";
import type { GlobalOptions } from "./context.js";

/**
 * glm-router project remove (spec §43): remove only the managed block,
 * preserve all user content, and delete router-created files that become empty.
 */
export function projectRemoveCommand(options: GlobalOptions): number {
  const root = findProjectRoot();
  const changes: ManagedFileChange[] = [
    removeClaudeIntegration(root, { dryRun: options.dryRun }),
    removeCodexIntegration(root, { dryRun: options.dryRun }),
  ];

  for (const change of changes) {
    if (options.dryRun) {
      if (change.changed) {
        const action = change.deleted ? "delete (router-created, now empty)" : "remove managed block from";
        process.stdout.write(`[dry-run] would ${action}: ${change.file}\n`);
      } else {
        process.stdout.write(`[dry-run] no managed block in ${change.file}\n`);
      }
      continue;
    }
    if (change.deleted) {
      process.stdout.write(`✓ ${change.file} — deleted (was created by glm-coding-router)\n`);
    } else if (change.changed) {
      process.stdout.write(`✓ ${change.file} — managed block removed\n`);
    } else {
      process.stdout.write(`✓ ${change.file} — no managed block present\n`);
    }
  }
  return 0;
}
