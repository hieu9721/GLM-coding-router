import os from "node:os";
import { loadConfig } from "../core/config.js";
import { locateClaude, locateCodex } from "../core/claude.js";
import { version } from "../core/version.js";
import { resolveZaiApiKey } from "../core/zai-key.js";
import { skillTargets } from "../integrations/skill.js";
import { GLM_DELEGATION_SKILL_NAME } from "../templates/glm-delegation-skill.js";
import { emitJson, type GlobalOptions } from "./context.js";
import { createCommandUi } from "../tui/command-ui.js";
import { createWriter, type Writer } from "../tui/render.js";

export interface StatusDeps {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readUserEnv?: (name: string) => string | undefined;
  readonly stdout?: NodeJS.WriteStream;
}

/** Fast, fully offline summary (spec §41, specs/terminal-ui-doctor.md §B.4) — no API requests, no key values. */
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

  const stream = deps.stdout ?? process.stdout;
  const writer: Writer = createWriter(stream);
  const ui = createCommandUi(writer, { quiet: options.quiet });

  const blocks: string[] = [];
  const header = ui.header(`GLM CODING ROUTER  v${version}  /  STATUS`, "Offline overview — credentials not verified this run");
  if (header) blocks.push(header);

  blocks.push(
    [
      ui.section("SYSTEM"),
      // Presence only, never validity — that claim belongs to `doctor` (spec §B.4).
      ui.row(
        "Z.ai key",
        resolved ? "configured (not verified — run: glm-router doctor)" : "not configured",
        resolved ? "ok" : "fail",
      ),
      ui.row("Claude", claudeInstalled ? "installed" : "missing", claudeInstalled ? "ok" : "fail"),
      ui.row("Codex", codexInstalled ? "installed" : "missing", codexInstalled ? "ok" : "warn"),
    ].join("\n"),
  );

  const integrationRows = [
    ui.section("INTEGRATIONS"),
    ui.row("Claude policy", config.integrations.claude ? "enabled" : "disabled", config.integrations.claude ? "ok" : "info"),
    ui.row("Codex policy", config.integrations.codex ? "enabled" : "disabled", config.integrations.codex ? "ok" : "info"),
  ];
  for (const row of skillState) {
    const enabled = row.homeDetected && row.installed;
    integrationRows.push(ui.row(`${row.agent} skill`, enabled ? "enabled" : "disabled", enabled ? "ok" : "info"));
  }
  blocks.push(integrationRows.join("\n"));

  blocks.push(
    [ui.section("MODELS"), ui.row("Main model", config.models.main), ui.row("Fast model", config.models.fast)].join(
      "\n",
    ),
  );

  const footer = ui.footer("Run: glm-router doctor to verify credentials and connectivity.");
  if (footer) blocks.push(footer);

  writer.line(blocks.join("\n\n"));
  return 0;
}
