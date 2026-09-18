import os from "node:os";
import { glmDelegationSkill, skillTargets } from "../integrations/skill.js";
import type { GlobalOptions } from "./context.js";

interface TargetResult {
  readonly agent: string;
  readonly outcome: "installed" | "already" | "skipped" | "removed" | "absent";
  readonly detail: string;
}

export interface SkillCommandDeps {
  readonly home?: string;
}

function runForEach(options: GlobalOptions, action: "install" | "remove", home: string): TargetResult[] {
  const skill = glmDelegationSkill();
  const results: TargetResult[] = [];
  for (const { agent, installer } of skillTargets(home)) {
    const location = installer.detect();
    if (!location) {
      results.push({ agent, outcome: "skipped", detail: "home not detected — skipping optional skill" });
      continue;
    }
    if (action === "install") {
      if (installer.isInstalled(skill.name) && !options.force) {
        results.push({ agent, outcome: "already", detail: `already installed at ${location.skillsDir}` });
        continue;
      }
      if (options.dryRun) {
        results.push({ agent, outcome: "skipped", detail: `[dry-run] would install to ${location.skillsDir}` });
        continue;
      }
      installer.install(skill);
      results.push({ agent, outcome: "installed", detail: `installed at ${location.skillsDir}` });
    } else {
      if (!installer.isInstalled(skill.name)) {
        results.push({ agent, outcome: "absent", detail: "not installed" });
        continue;
      }
      if (options.dryRun) {
        results.push({ agent, outcome: "skipped", detail: "[dry-run] would remove skill" });
        continue;
      }
      installer.remove(skill.name);
      results.push({ agent, outcome: "removed", detail: "removed" });
    }
  }
  return results;
}

function render(results: readonly TargetResult[]): number {
  for (const result of results) {
    process.stdout.write(`✓ ${result.agent}: ${result.detail}\n`);
  }
  return 0;
}

/**
 * glm-router skill install (spec §27, specs/v1-architecture.md): optional
 * enhancement for BOTH agents; per-agent warn+skip, never fatal.
 */
export function skillInstallCommand(options: GlobalOptions, deps: SkillCommandDeps = {}): number {
  return render(runForEach(options, "install", deps.home ?? os.homedir()));
}

/** glm-router skill remove — removes from both agents. */
export function skillRemoveCommand(options: GlobalOptions, deps: SkillCommandDeps = {}): number {
  return render(runForEach(options, "remove", deps.home ?? os.homedir()));
}
