import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "../project/atomic-write.js";
import {
  GLM_DELEGATION_SKILL_MD,
  GLM_DELEGATION_SKILL_NAME,
} from "../templates/glm-delegation-skill.js";

/** Skill installation is an optional enhancement — never block the core tool on it (spec §27). */
export interface SkillLocation {
  /** Directory that holds skill folders, e.g. ~/.codex/skills. */
  readonly skillsDir: string;
}

export interface SkillDefinition {
  readonly name: string;
  readonly content: string;
}

export interface SkillInstaller {
  detect(): SkillLocation | null;
  install(skill: SkillDefinition): void;
  remove(name: string): void;
  isInstalled(name: string): boolean;
}

/**
 * Shared SKILL.md-folder mechanics; subclasses only pick the agent home dir
 * (specs/v1-architecture.md). Detection stays conservative: a missing home
 * means no supported installation to enhance — return null, callers warn+skip.
 */
abstract class HomeDirSkillInstaller implements SkillInstaller {
  protected constructor(protected readonly agentHome: string) {}

  public detect(): SkillLocation | null {
    if (!fs.existsSync(this.agentHome)) {
      return null;
    }
    return { skillsDir: path.join(this.agentHome, "skills") };
  }

  public install(skill: SkillDefinition): void {
    const skillDir = path.join(this.agentHome, "skills", skill.name);
    atomicWriteFile(path.join(skillDir, "SKILL.md"), skill.content);
  }

  public remove(name: string): void {
    const skillDir = path.join(this.agentHome, "skills", name);
    fs.rmSync(skillDir, { recursive: true, force: true });
  }

  public isInstalled(name: string): boolean {
    return fs.existsSync(path.join(this.agentHome, "skills", name, "SKILL.md"));
  }
}

/** Installs skills into the Codex home (~/.codex/skills). */
export class CodexSkillInstaller extends HomeDirSkillInstaller {
  public constructor(home: string) {
    super(path.join(home, ".codex"));
  }
}

/** Installs skills into the Claude Code home (~/.claude/skills, specs/v1-architecture.md). */
export class ClaudeSkillInstaller extends HomeDirSkillInstaller {
  public constructor(home: string) {
    super(path.join(home, ".claude"));
  }
}

/** Every agent the delegation skill supports, in stable display order. */
export function skillTargets(home: string): { agent: string; installer: SkillInstaller }[] {
  return [
    { agent: "Claude", installer: new ClaudeSkillInstaller(home) },
    { agent: "Codex", installer: new CodexSkillInstaller(home) },
  ];
}

export function glmDelegationSkill(): SkillDefinition {
  return { name: GLM_DELEGATION_SKILL_NAME, content: GLM_DELEGATION_SKILL_MD };
}
