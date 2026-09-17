import prompts from "prompts";
import fs from "node:fs";
import os from "node:os";
import { loadConfig, saveConfig, type RouterConfig } from "../core/config.js";
import { configPath } from "../core/paths.js";
import { runDoctorChecks, type CheckResult } from "./doctor.js";
import { setWindowsUserEnv, ZAI_API_KEY_ENV } from "../core/zai-key.js";
import { isWindows } from "../core/platform.js";
import { CodexSkillInstaller, glmDelegationSkill } from "../integrations/skill.js";
import type { GlobalOptions } from "./context.js";
import { version } from "../core/version.js";

function renderEnvironment(results: readonly CheckResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const symbol = result.status === "ok" ? "✓" : result.status === "warn" ? "⚠" : "✗";
    lines.push(`${symbol} ${result.name}`);
  }
  return lines.join("\n");
}

interface InitChoices {
  configureKey: boolean;
  claude: boolean;
  codex: boolean;
  codexSkill: boolean;
}

async function askChoices(existingKey: boolean, options: GlobalOptions): Promise<InitChoices> {
  if (options.yes) {
    return { configureKey: !existingKey, claude: true, codex: true, codexSkill: true };
  }
  if (!process.stdin.isTTY) {
    process.stdout.write(
      "Non-interactive terminal detected. Re-run with --yes to accept defaults.\n",
    );
    process.exit(2);
  }

  const response = await prompts([
    {
      type: existingKey ? null : "confirm",
      name: "configureKey",
      message: "Configure Z.ai Coding Plan key?",
      initial: true,
    },
    { type: "confirm", name: "claude", message: "Install Claude integration?", initial: true },
    { type: "confirm", name: "codex", message: "Install Codex integration?", initial: true },
    { type: "confirm", name: "codexSkill", message: "Install Codex delegation skill?", initial: true },
  ]);

  if (response.claude === undefined) {
    process.stdout.write("Cancelled.\n");
    process.exit(1);
  }
  return {
    configureKey: existingKey ? true : Boolean(response.configureKey),
    claude: Boolean(response.claude),
    codex: Boolean(response.codex),
    codexSkill: Boolean(response.codexSkill),
  };
}

/** glm-router init (spec §7): environment report, key setup, config, skill. Idempotent. */
export async function initCommand(options: GlobalOptions): Promise<number> {
  process.stdout.write(`GLM Coding Router v${version}\n\n`);

  const report = runDoctorChecks();
  process.stdout.write("Environment\n\n");
  process.stdout.write(renderEnvironment(report.results) + "\n\n");

  const existingKey = report.keySource !== undefined;
  const choices = await askChoices(existingKey, options);

  process.stdout.write("\nInstalling...\n\n");
  const home = os.homedir();
  const config = loadConfig();
  const nextConfig: RouterConfig = {
    ...config,
    integrations: {
      claude: choices.claude,
      codex: choices.codex,
      codexSkill: choices.codexSkill,
    },
  };

  // Z.ai key
  if (existingKey) {
    process.stdout.write(`✓ ${ZAI_API_KEY_ENV} already configured (${report.keySource})\n`);
  } else if (choices.configureKey) {
    if (!isWindows()) {
      process.stdout.write("⚠ Key storage requires Windows in v0.1 — skipped\n");
    } else {
      const keyResponse = await prompts({
        type: "password",
        name: "key",
        message: "Enter Z.ai Coding Plan API key:",
        validate: (value: string) => (value.trim().length > 0 ? true : "Key cannot be empty"),
      });
      if (keyResponse.key === undefined) {
        process.stderr.write("Cancelled.\n");
        return 1;
      }
      setWindowsUserEnv(ZAI_API_KEY_ENV, String(keyResponse.key).trim());
      process.stdout.write(`✓ ${ZAI_API_KEY_ENV} configured\n`);
    }
  } else {
    process.stdout.write(`⚠ Skipped — run "glm-router key set" later\n`);
  }

  // Config
  const alreadyConfigured = fs.existsSync(configPath(home));
  saveConfig(nextConfig, home);
  process.stdout.write(
    alreadyConfigured
      ? `✓ Configuration updated (${configPath(home)})\n`
      : `✓ Configuration created (${configPath(home)})\n`,
  );

  // GLM commands
  process.stdout.write(`✓ GLM commands available: glm-chat, glm-worker, glm-review\n`);

  // Integrations
  process.stdout.write(
    choices.claude ? "✓ Claude integration ready (CLAUDE.md managed block via: glm-router project init)\n"
      : "⚠ Claude integration disabled\n",
  );
  process.stdout.write(
    choices.codex ? "✓ Codex integration ready (AGENTS.md managed block via: glm-router project init)\n"
      : "⚠ Codex integration disabled\n",
  );

  // Skill
  if (choices.codexSkill) {
    const skillInstaller = new CodexSkillInstaller(home);
    if (skillInstaller.detect()) {
      skillInstaller.install(glmDelegationSkill());
      process.stdout.write("✓ Codex skill installed\n");
    } else {
      process.stdout.write(
        "⚠ Codex home (~/.codex) not detected — skill skipped (optional). AGENTS.md integration is unaffected.\n",
      );
    }
  } else {
    process.stdout.write("⚠ Codex skill skipped\n");
  }

  process.stdout.write("\nSetup complete.\n\nRun:\n\n  glm-router doctor\n");
  return 0;
}
