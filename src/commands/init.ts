import prompts from "prompts";
import fs from "node:fs";
import os from "node:os";
import { loadConfig, saveConfig, type RouterConfig } from "../core/config.js";
import { configPath } from "../core/paths.js";
import { ExitCode } from "../core/errors.js";
import { runDoctorChecks, type CheckResult } from "./doctor.js";
import { setWindowsUserEnv, ZAI_API_KEY_ENV } from "../core/zai-key.js";
import { detectUserEnvStore, type UserEnvStore } from "../core/user-env.js";
import { printShellKeyGuidance } from "./key.js";
import { CodexSkillInstaller, glmDelegationSkill } from "../integrations/skill.js";
import type { GlobalOptions } from "./context.js";
import type { PromptFn } from "./key.js";
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

type AskChoicesResult =
  | { kind: "ok"; choices: InitChoices }
  | { kind: "non-interactive" }
  | { kind: "cancelled" };

async function askChoices(
  existingKey: boolean,
  options: GlobalOptions,
  prompt: PromptFn,
): Promise<AskChoicesResult> {
  if (options.yes) {
    return { kind: "ok", choices: { configureKey: !existingKey, claude: true, codex: true, codexSkill: true } };
  }
  if (!process.stdin.isTTY) {
    return { kind: "non-interactive" };
  }

  const response = await prompt([
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
    return { kind: "cancelled" };
  }
  return {
    kind: "ok",
    choices: {
      configureKey: existingKey ? true : Boolean(response.configureKey),
      claude: Boolean(response.claude),
      codex: Boolean(response.codex),
      codexSkill: Boolean(response.codexSkill),
    },
  };
}

export interface InitDeps {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readUserEnv?: (name: string) => string | undefined;
  readonly setEnv?: (name: string, value: string) => void;
  readonly prompt?: PromptFn;
  /** Defaults to this machine's detected store — injected by tests. */
  readonly store?: UserEnvStore;
}

/** glm-router init (spec §7): environment report, key setup, config, skill. Idempotent. */
export async function initCommand(options: GlobalOptions, deps: InitDeps = {}): Promise<number> {
  const prompt = deps.prompt ?? prompts;
  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const setEnv = deps.setEnv ?? setWindowsUserEnv;

  process.stdout.write(`GLM Coding Router v${version}\n\n`);

  const report = runDoctorChecks({ home, env, readUserEnv: deps.readUserEnv });
  process.stdout.write("Environment\n\n");
  process.stdout.write(renderEnvironment(report.results) + "\n\n");

  const existingKey = report.keySource !== undefined;
  const askResult = await askChoices(existingKey, options, prompt);
  if (askResult.kind === "non-interactive") {
    process.stdout.write("Non-interactive terminal detected. Re-run with --yes to accept defaults.\n");
    return ExitCode.InvalidArgs;
  }
  if (askResult.kind === "cancelled") {
    process.stdout.write("Cancelled.\n");
    return ExitCode.GenericFailure;
  }
  const choices = askResult.choices;

  process.stdout.write("\nInstalling...\n\n");
  const config = loadConfig(home);
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
    if ((deps.store ?? detectUserEnvStore()) === "none") {
      // No persistent store here; tell the user the one line that works.
      printShellKeyGuidance({ env: deps.env });
    } else {
      const keyResponse = await prompt({
        type: "password",
        name: "key",
        message: "Enter Z.ai Coding Plan API key:",
        validate: (value: string) => (value.trim().length > 0 ? true : "Key cannot be empty"),
      });
      if (keyResponse.key === undefined) {
        process.stderr.write("Cancelled.\n");
        return 1;
      }
      setEnv(ZAI_API_KEY_ENV, String(keyResponse.key).trim());
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
