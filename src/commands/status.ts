import os from "node:os";
import { loadConfig } from "../core/config.js";
import { locateClaude, locateCodex } from "../core/claude.js";
import { version } from "../core/version.js";
import { resolveZaiApiKey } from "../core/zai-key.js";
import { CodexSkillInstaller } from "../integrations/skill.js";
import { GLM_DELEGATION_SKILL_NAME } from "../templates/glm-delegation-skill.js";
import { emitJson, type GlobalOptions } from "./context.js";

/** Fast, fully offline summary (spec §41) — no API requests, no key values. */
export function statusCommand(options: GlobalOptions): number {
  const config = loadConfig();
  const home = os.homedir();
  const resolved = resolveZaiApiKey();
  const claudeInstalled = (() => {
    try {
      locateClaude(config);
      return true;
    } catch {
      return false;
    }
  })();
  const codexInstalled = Boolean(locateCodex(config));
  const skillInstaller = new CodexSkillInstaller(home);
  const skillInstalled =
    skillInstaller.detect() !== null && skillInstaller.isInstalled(GLM_DELEGATION_SKILL_NAME);

  if (options.json) {
    emitJson({
      version,
      zaiKeyConfigured: Boolean(resolved),
      claude: claudeInstalled ? "installed" : "missing",
      codex: codexInstalled ? "installed" : "missing",
      integrations: {
        claude: config.integrations.claude,
        codex: config.integrations.codex,
        codexSkill: config.integrations.codexSkill && skillInstalled,
      },
      models: config.models,
    });
    return 0;
  }

  const lines = [
    `GLM Coding Router v${version}`,
    "",
    `Z.ai key        ${resolved ? "configured" : "not configured"}`,
    `Claude          ${claudeInstalled ? "installed" : "missing"}`,
    `Codex           ${codexInstalled ? "installed" : "missing"}`,
    "",
    `Claude policy   ${config.integrations.claude ? "enabled" : "disabled"}`,
    `Codex policy    ${config.integrations.codex ? "enabled" : "disabled"}`,
    `Codex skill     ${skillInstalled ? "enabled" : "disabled"}`,
    "",
    `Main model      ${config.models.main}`,
    `Fast model      ${config.models.fast}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
