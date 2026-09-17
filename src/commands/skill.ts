import os from "node:os";
import { CodexSkillInstaller, glmDelegationSkill } from "../integrations/skill.js";
import type { GlobalOptions } from "./context.js";

function installer(): CodexSkillInstaller {
  return new CodexSkillInstaller(os.homedir());
}

/** glm-router skill install (spec §27): optional enhancement; warn+skip when unsupported. */
export function skillInstallCommand(options: GlobalOptions): number {
  const skillInstaller = installer();
  const location = skillInstaller.detect();
  if (!location) {
    process.stdout.write(
      "⚠ Codex skill directory not detected (~/.codex not found).\n" +
        "  Skipping optional skill — AGENTS.md integration keeps working.\n",
    );
    return 0;
  }

  const skill = glmDelegationSkill();
  if (skillInstaller.isInstalled(skill.name) && !options.force) {
    process.stdout.write(`✓ Skill "${skill.name}" already installed\n`);
    return 0;
  }

  if (options.dryRun) {
    process.stdout.write(`[dry-run] would install skill "${skill.name}" to ${location.skillsDir}\n`);
    return 0;
  }

  skillInstaller.install(skill);
  process.stdout.write(`✓ Skill "${skill.name}" installed at ${location.skillsDir}\n`);
  return 0;
}

/** glm-router skill remove. */
export function skillRemoveCommand(options: GlobalOptions): number {
  const skillInstaller = installer();
  const skill = glmDelegationSkill();
  if (!skillInstaller.isInstalled(skill.name)) {
    process.stdout.write(`✓ Skill "${skill.name}" is not installed\n`);
    return 0;
  }
  if (options.dryRun) {
    process.stdout.write(`[dry-run] would remove skill "${skill.name}"\n`);
    return 0;
  }
  skillInstaller.remove(skill.name);
  process.stdout.write(`✓ Skill "${skill.name}" removed\n`);
  return 0;
}
