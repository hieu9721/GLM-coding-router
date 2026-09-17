import os from "node:os";
import { execFileSync } from "node:child_process";
import { defaultConfig, loadConfig, type RouterConfig } from "../core/config.js";
import { locateClaude, locateCodex, searchPathFor } from "../core/claude.js";
import { isWindows, windowsVersionName } from "../core/platform.js";
import { resolveZaiApiKey, type ZaiKeySource } from "../core/zai-key.js";
import { configPath } from "../core/paths.js";
import fs from "node:fs";
import { CodexSkillInstaller } from "../integrations/skill.js";
import { GLM_DELEGATION_SKILL_NAME } from "../templates/glm-delegation-skill.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  readonly section: string;
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
  /** Extra explanation printed under the check (spec §9 Environment note). */
  readonly note?: string;
}

function check(
  section: string,
  name: string,
  status: CheckStatus,
  detail?: string,
  note?: string,
): CheckResult {
  return { section, name, status, detail, note };
}

function nodeVersionMajor(): number {
  return Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
}

function gitFound(): boolean {
  try {
    execFileSync("git", ["--version"], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface DoctorReport {
  readonly results: readonly CheckResult[];
  readonly config: RouterConfig;
  readonly keySource: ZaiKeySource | undefined;
}

/** All doctor checks (spec §9). Read-only; never exposes the key value. */
export function runDoctorChecks(
  options: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    readUserEnv?: (name: string) => string | undefined;
  } = {},
): DoctorReport {
  const results: CheckResult[] = [];
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;

  // --- System ---
  results.push(
    check(
      "System",
      isWindows() ? windowsVersionName() : `Platform ${process.platform}`,
      isWindows() ? "ok" : "fail",
      undefined,
      isWindows() ? undefined : "v0.1 targets Windows only.",
    ),
  );
  const nodeMajor = nodeVersionMajor();
  results.push(
    check(
      "System",
      `Node.js ${process.versions.node}`,
      nodeMajor >= 20 ? "ok" : "fail",
      undefined,
      nodeMajor >= 20 ? undefined : "glm-coding-router requires Node.js >= 20.",
    ),
  );
  results.push(check("System", "Git", gitFound() ? "ok" : "warn"));

  // --- Z.ai / config ---
  let config: RouterConfig = defaultConfig();
  const configFile = configPath(home);
  const configExists = fs.existsSync(configFile);
  if (!configExists) {
    results.push(check("Z.ai", "Configuration", "ok", "defaults (config.json not created yet)"));
  } else {
    try {
      config = loadConfig(home);
      results.push(check("Z.ai", "Configuration", "ok", configFile));
    } catch (error) {
      results.push(
        check(
          "Z.ai",
          "Configuration",
          "fail",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  // --- Agents ---
  try {
    const claudePath = locateClaude(config, env);
    results.push(check("Agents", "Claude Code", "ok", claudePath));
  } catch (error) {
    results.push(
      check("Agents", "Claude Code", "fail", error instanceof Error ? error.message : String(error)),
    );
  }
  const codexPath = locateCodex(config, env);
  results.push(
    check(
      "Agents",
      "Codex",
      codexPath ? "ok" : "warn",
      codexPath,
      codexPath ? undefined : "Optional — Claude-only setups are supported.",
    ),
  );

  // --- Z.ai key ---
  const resolved = resolveZaiApiKey({ env, readUserEnv: options.readUserEnv });
  results.push(
    check(
      "Z.ai",
      "ZAI_API_KEY",
      resolved ? "ok" : "fail",
      resolved ? `configured (${resolved.source})` : "not found",
      resolved ? undefined : "Run: glm-router key set",
    ),
  );
  results.push(check("Z.ai", "Anthropic endpoint", "ok", config.provider.anthropicBaseUrl));

  // --- Commands (PATH shims; a dev checkout warns instead of failing) ---
  for (const command of ["glm-chat", "glm-worker", "glm-review"]) {
    const found = searchPathFor(command);
    results.push(
      check(
        "Commands",
        command,
        found ? "ok" : "warn",
        found,
        found ? undefined : "Not on PATH — install globally (npm install -g glm-coding-router) or use npm run dev.",
      ),
    );
  }

  // --- Claude / Codex integrations ---
  results.push(
    check(
      "Claude",
      "Integration",
      config.integrations.claude ? "ok" : "warn",
      config.integrations.claude ? "enabled" : "disabled in config",
    ),
  );
  results.push(
    check(
      "Codex",
      "AGENTS.md integration",
      config.integrations.codex ? "ok" : "warn",
      config.integrations.codex ? "enabled" : "disabled in config",
    ),
  );
  const skillInstaller = new CodexSkillInstaller(home);
  const skillDetected = skillInstaller.detect() !== null;
  const skillInstalled = skillDetected && skillInstaller.isInstalled(GLM_DELEGATION_SKILL_NAME);
  results.push(
    check(
      "Codex",
      "Delegation skill",
      skillInstalled ? "ok" : "warn",
      skillInstalled
        ? "installed"
        : skillDetected
          ? "not installed (optional)"
          : "Codex home not detected — skill skipped (optional)",
    ),
  );

  // --- Environment: the Orca stale-env case (spec §9, §10) ---
  const hasProcessKey = Boolean(env.ZAI_API_KEY && env.ZAI_API_KEY.trim());
  if (hasProcessKey) {
    results.push(
      check("Environment", "Process environment", "ok", "ZAI_API_KEY visible in current process"),
    );
  } else if (resolved) {
    results.push(
      check(
        "Environment",
        "Process environment",
        "warn",
        "Current process does not contain ZAI_API_KEY",
        "This is safe. GLM workers reload the key automatically from the Windows User Environment.",
      ),
    );
  }

  return { results, config, keySource: resolved?.source };
}

export function doctorHasFailures(results: readonly CheckResult[]): boolean {
  return results.some((result) => result.status === "fail");
}
