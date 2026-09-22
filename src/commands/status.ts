import os from "node:os";
import { loadConfig } from "../core/config.js";
import { locateClaude, locateCodex } from "../core/claude.js";
import { version } from "../core/version.js";
import { resolveZaiApiKey } from "../core/zai-key.js";
import { skillTargets } from "../integrations/skill.js";
import { GLM_DELEGATION_SKILL_NAME } from "../templates/glm-delegation-skill.js";
import { emitJson, type GlobalOptions } from "./context.js";

export interface StatusDeps {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readUserEnv?: (name: string) => string | undefined;
}

/** Fast, fully offline summary (spec §41) — no API requests, no key values. */
export function statusCommand(options: GlobalOptions, deps: StatusDeps = {}): number {
  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const config = loadConfig(home);
  const resolved = resolveZaiApiKey({ env, readUserEnv: deps.readUserEnv });
  const claudeInstalled = (() => {
    try {
      locateClaude(config, env);
      return true;
    } catch {
      return false;
    }
  })();
  const codexInstalled = Boolean(locateCodex(config, env));
  const skillState = (() => {
    const rows: { agent: string; homeDetected: boolean; installed: boolean }[] = [];
    for (const { agent, installer } of skillTargets(home)) {
      rows.push({
        agent,
        homeDetected: installer.detect() !== null,
        installed: installer.isInstalled(GLM_DELEGATION_SKILL_NAME),
      });
    }
    return rows;
  })();

  if (options.json) {
    emitJson({
      version,
      zaiKeyConfigured: Boolean(resolved),
      claude: claudeInstalled ? "installed" : "missing",
      codex: codexInstalled ? "installed" : "missing",
      integrations: {
        claude: config.integrations.claude,
        codex: config.integrations.codex,
        skills: skillState.map((row) => ({
          agent: row.agent,
          enabled: row.homeDetected && row.installed,
        })),
      },
      models: config.models,
    });
    return 0;
  }

  /** Every status row pads its label to this column (spec §41). */
  const LABEL_WIDTH = 16;
  const lines = [
    `GLM Coding Router v${version}`,
    "",
    `Z.ai key        ${resolved ? "configured (not verified — run: glm-router doctor)" : "not configured"}`,
    `Claude          ${claudeInstalled ? "installed" : "missing"}`,
    `Codex           ${codexInstalled ? "installed" : "missing"}`,
    "",
    `Claude policy   ${config.integrations.claude ? "enabled" : "disabled"}`,
    `Codex policy    ${config.integrations.codex ? "enabled" : "disabled"}`,
  ];
  for (const row of skillState) {
    const enabled = row.homeDetected && row.installed;
    lines.push(`${`${row.agent} skill`.padEnd(LABEL_WIDTH)}${enabled ? "enabled" : "disabled"}`);
  }
  lines.push(
    "",
    `Main model      ${config.models.main}`,
    `Fast model      ${config.models.fast}`,
  );
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
