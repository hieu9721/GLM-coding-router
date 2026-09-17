import { findProjectRoot } from "../project/project-root.js";
import { installClaudeIntegration } from "../integrations/claude.js";
import { installCodexIntegration } from "../integrations/codex.js";
import type { ManagedFileChange } from "../project/managed-file.js";
import { loadConfig } from "../core/config.js";
import type { GlobalOptions } from "./context.js";

/** Lines of the managed block region (markers included), for --dry-run previews (spec §45). */
function managedLines(content: string): string[] {
  const start = content.indexOf("<!-- glm-coding-router:start -->");
  if (start === -1) return [];
  const endMarker = "<!-- glm-coding-router:end -->";
  const end = content.indexOf(endMarker);
  const regionEnd = end === -1 ? content.length : end + endMarker.length;
  return content.slice(start, regionEnd).split(/\r?\n/);
}

/** Unified-diff-style preview for --dry-run (spec §45). */
export function renderChangeDiff(change: ManagedFileChange): string {
  const lines: string[] = [];
  lines.push(`--- ${change.file}${change.created ? " (new file)" : ""}`);
  for (const line of managedLines(change.oldContent)) {
    lines.push(`- ${line}`);
  }
  for (const line of managedLines(change.newContent)) {
    lines.push(`+ ${line}`);
  }
  return lines.join("\n");
}

/**
 * glm-router project init (spec §19, §23): create/update the managed block in
 * CLAUDE.md and AGENTS.md at the project root. Idempotent; never overwrites
 * user content; supports --dry-run.
 */
export function projectInitCommand(options: GlobalOptions): number {
  const root = findProjectRoot();
  const config = loadConfig();
  const changes: ManagedFileChange[] = [];

  if (config.integrations.claude) {
    changes.push(installClaudeIntegration(root, { dryRun: options.dryRun }));
  }
  if (config.integrations.codex) {
    changes.push(installCodexIntegration(root, { dryRun: options.dryRun }));
  }

  if (changes.length === 0) {
    process.stdout.write("All integrations are disabled in config — nothing to do.\n");
    return 0;
  }

  for (const change of changes) {
    if (options.dryRun) {
      process.stdout.write(`[dry-run] would update ${change.file}:\n${renderChangeDiff(change)}\n`);
    } else if (!change.changed) {
      process.stdout.write(`✓ ${change.file} — already up to date\n`);
    } else if (change.created) {
      process.stdout.write(`✓ ${change.file} — created\n`);
    } else {
      process.stdout.write(`✓ ${change.file} — managed block updated\n`);
    }
  }
  return 0;
}
