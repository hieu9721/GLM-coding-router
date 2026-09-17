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
 * Installs SKILL.md-based skills into the Codex home (~/.codex/skills).
 * Detection is conservative: if ~/.codex does not exist there is no
 * supported Codex installation to enhance — return null and let callers warn+skip.
 */
export class CodexSkillInstaller implements SkillInstaller {
  private readonly codexHome: string;

  public constructor(home: string) {
    this.codexHome = path.join(home, ".codex");
  }

  public detect(): SkillLocation | null {
    if (!fs.existsSync(this.codexHome)) {
      return null;
    }
    return { skillsDir: path.join(this.codexHome, "skills") };
  }

  public install(skill: SkillDefinition): void {
    const skillDir = path.join(this.codexHome, "skills", skill.name);
    atomicWriteFile(path.join(skillDir, "SKILL.md"), skill.content);
  }

  public remove(name: string): void {
    const skillDir = path.join(this.codexHome, "skills", name);
    fs.rmSync(skillDir, { recursive: true, force: true });
  }

  public isInstalled(name: string): boolean {
    return fs.existsSync(path.join(this.codexHome, "skills", name, "SKILL.md"));
  }
}

export function glmDelegationSkill(): SkillDefinition {
  return { name: GLM_DELEGATION_SKILL_NAME, content: GLM_DELEGATION_SKILL_MD };
}
