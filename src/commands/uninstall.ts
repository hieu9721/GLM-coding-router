import prompts from "prompts";
import fs from "node:fs";
import os from "node:os";
import { configDir } from "../core/paths.js";
import { ExitCode } from "../core/errors.js";
import { describeKeyStore, detectUserEnvStore } from "../core/user-env.js";
import { CodexSkillInstaller, glmDelegationSkill } from "../integrations/skill.js";
import { keyRemoveCommand, type PromptFn } from "./key.js";
import { removeClaudeIntegration, removeCodexIntegration } from "../integrations/index.js";
import type { GlobalOptions } from "./context.js";

interface UninstallChoices {
  removeConfig: boolean;
  removeSkill: boolean;
  removeProjectIntegration: boolean;
  removeKey: boolean;
}

type AskChoicesResult =
  | { kind: "ok"; choices: UninstallChoices }
  | { kind: "non-interactive" }
  | { kind: "cancelled" };

async function askChoices(options: GlobalOptions, prompt: PromptFn): Promise<AskChoicesResult> {
  // Defaults per spec §44: keep ZAI_API_KEY; destructive credential removal
  // requires explicit consent, so --yes never flips it.
  const defaults: UninstallChoices = {
    removeConfig: true,
    removeSkill: true,
    removeProjectIntegration: false,
    removeKey: false,
  };
  if (options.yes || options.force) {
    return {
      kind: "ok",
      choices: options.force ? { ...defaults, removeProjectIntegration: true } : defaults,
    };
  }
  if (!process.stdin.isTTY) {
    return { kind: "non-interactive" };
  }

  const response = await prompt([
    { type: "confirm", name: "removeConfig", message: "Remove global configuration?", initial: true },
    { type: "confirm", name: "removeSkill", message: "Remove Codex skill?", initial: true },
    { type: "confirm", name: "removeProject", message: "Remove current project integration?", initial: false },
    { type: "confirm", name: "removeKey", message: "Remove ZAI_API_KEY?", initial: false },
  ]);

  if (response.removeConfig === undefined) {
    return { kind: "cancelled" };
  }
  return {
    kind: "ok",
    choices: {
      removeConfig: Boolean(response.removeConfig),
      removeSkill: Boolean(response.removeSkill),
      removeProjectIntegration: Boolean(response.removeProject),
      removeKey: Boolean(response.removeKey),
    },
  };
}

export interface UninstallDeps {
  readonly home?: string;
  readonly root?: string;
  readonly prompt?: PromptFn;
  readonly deleteEnv?: (name: string) => void;
}

/** glm-router uninstall (spec §44): wizard with safe defaults. */
export async function uninstallCommand(
  options: GlobalOptions,
  deps: UninstallDeps = {},
): Promise<number> {
  const askResult = await askChoices(options, deps.prompt ?? prompts);
  if (askResult.kind === "non-interactive") {
    process.stdout.write("Non-interactive terminal detected. Re-run with --yes for safe defaults.\n");
    return ExitCode.InvalidArgs;
  }
  if (askResult.kind === "cancelled") {
    process.stdout.write("Cancelled.\n");
    return ExitCode.GenericFailure;
  }
  const choices = askResult.choices;
  const home = deps.home ?? os.homedir();

  if (choices.removeSkill) {
    const skillInstaller = new CodexSkillInstaller(home);
    const skill = glmDelegationSkill();
    if (skillInstaller.isInstalled(skill.name)) {
      skillInstaller.remove(skill.name);
      process.stdout.write("✓ Codex skill removed\n");
    } else {
      process.stdout.write("✓ Codex skill not installed\n");
    }
  }

  if (choices.removeProjectIntegration) {
    const root = deps.root ?? process.cwd();
    removeClaudeIntegration(root);
    removeCodexIntegration(root);
    process.stdout.write("✓ Project integration removed (CLAUDE.md / AGENTS.md managed blocks)\n");
  }

  if (choices.removeConfig) {
    const dir = configDir(home);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      process.stdout.write(`✓ Global configuration removed (${dir})\n`);
    } else {
      process.stdout.write("✓ Global configuration not present\n");
    }
  }

  if (choices.removeKey) {
    await keyRemoveCommand({ deleteEnv: deps.deleteEnv });
    process.stdout.write(`✓ ZAI_API_KEY removed from ${describeKeyStore(detectUserEnvStore())}\n`);
  } else {
    process.stdout.write("✓ ZAI_API_KEY kept\n");
  }

  process.stdout.write("\nUninstall complete. Run `npm uninstall -g glm-coding-router` to remove the binaries.\n");
  return 0;
}
