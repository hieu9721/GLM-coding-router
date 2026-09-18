import os from "node:os";
import type { RouterConfig } from "../core/config.js";
import { loadConfig } from "../core/config.js";
import { locateClaude } from "../core/claude.js";
import { createGlmEnv } from "../core/env.js";
import { Errors } from "../core/errors.js";
import { gitTopLevel, type RunGit } from "../core/git.js";
import { logger, redact } from "../core/logging.js";
import { spawnAgent } from "../core/process.js";
import { applyProfile } from "../core/profile.js";
import { readStdin, resolvePrompt } from "../core/prompt.js";
import { resolveZaiApiKey } from "../core/zai-key.js";
import {
  createDelegateWorktree,
  delegateBranch,
  delegateWorktreePath,
  removeDelegateWorktree,
  rollbackDelegateBranch,
  validateDelegateName,
} from "../core/worktree.js";
import { buildWorkerArgs } from "../bin/glm-worker.js";
import { emitJson, type GlobalOptions } from "./context.js";

export interface DelegateOptions extends GlobalOptions {
  readonly profile?: string;
  readonly remove?: boolean;
}

/** Default spawn for the worker; tests inject a recorder. */
export type SpawnWorker = (binPath: string, options: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly interactive: boolean;
}) => Promise<number>;

export interface DelegateDeps {
  readonly cwd?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readUserEnv?: (name: string) => string | undefined;
  readonly readStdinFn?: () => Promise<string | undefined>;
  readonly spawn?: SpawnWorker;
  readonly runGit?: RunGit;
}

/** A profile literally named after the delegate applies unless --profile says otherwise. */
function resolveProfileName(name: string, options: DelegateOptions, config: RouterConfig): string | undefined {
  if (options.profile) {
    return options.profile;
  }
  return config.profiles[name] ? name : undefined;
}

function banner(text: string, quiet: boolean | undefined): void {
  if (!quiet) {
    process.stdout.write(`${text}\n`);
  }
}

/**
 * glm-router delegate (spec §54 v0.3, specs/delegate-worktrees.md): run a GLM
 * worker in an isolated git worktree. Worktree + branch are kept after the run
 * (no automatic git commits); --remove drops the worktree after success only.
 */
export async function delegateCommand(
  name: string,
  promptArgs: readonly string[],
  options: DelegateOptions,
  deps: DelegateDeps = {},
): Promise<number> {
  validateDelegateName(name);

  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const runGit = deps.runGit;
  const repoRoot = await gitTopLevel(cwd, runGit);
  if (!repoRoot) {
    throw Errors.gitRepoRequired(cwd);
  }

  const home = deps.home ?? os.homedir();
  const baseConfig = loadConfig(home);
  const profileName = resolveProfileName(name, options, baseConfig);
  const config = applyProfile(baseConfig, profileName);

  const resolved = resolveZaiApiKey({ env, readUserEnv: deps.readUserEnv });
  if (!resolved) {
    throw Errors.zaiKeyMissing();
  }
  const claudePath = locateClaude(config, env);

  const prompt = await resolvePrompt(promptArgs, deps.readStdinFn ?? readStdin, "glm-router delegate");

  const branch = delegateBranch(name);
  const worktreePath = delegateWorktreePath(repoRoot, name);

  if (options.dryRun) {
    if (options.json) {
      emitJson({ name, profile: profileName ?? null, worktree: worktreePath, branch, dryRun: true });
    } else {
      banner(`would create worktree ${worktreePath}`, options.quiet);
      banner(`would create branch   ${branch} (from HEAD)`, options.quiet);
      banner(`would run glm-worker in the worktree with the given prompt`, options.quiet);
    }
    return 0;
  }

  // Collision checks run inside createDelegateWorktree before anything is written.
  const createdPath = await createDelegateWorktree(repoRoot, name, { runGit });

  if (options.json) {
    emitJson({ name, profile: profileName ?? null, worktree: createdPath, branch });
  } else {
    banner(`[glm-router] delegate ${name}`, options.quiet);
    banner(`[glm-router] worktree ${createdPath}`, options.quiet);
    banner(`[glm-router] branch   ${branch}`, options.quiet);
    if (profileName) {
      banner(`[glm-router] profile  ${profileName}`, options.quiet);
    }
  }

  const args = buildWorkerArgs(prompt, config);
  const childEnv = createGlmEnv(config, resolved.key, env);
  logger.debug(redact(`spawning ${claudePath} in ${createdPath}`, [resolved.key]));

  const spawn = deps.spawn ?? ((binPath, spawnOptions) =>
    spawnAgent(binPath, {
      args: [...spawnOptions.args],
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      interactive: false,
    }));
  let exitCode: number;
  try {
    exitCode = await spawn(claudePath, { args, cwd: createdPath, env: childEnv, interactive: false });
  } catch (error) {
    // Worker never started: roll back the pristine worktree and its branch so
    // the same delegate name can simply be re-run.
    const worktreeComplaint = await removeDelegateWorktree(repoRoot, createdPath, { runGit });
    if (worktreeComplaint) {
      logger.debug(`worktree kept after spawn failure: ${worktreeComplaint}`);
    }
    const branchComplaint = await rollbackDelegateBranch(repoRoot, branch, { runGit });
    if (branchComplaint) {
      logger.debug(`branch kept after spawn failure: ${branchComplaint}`);
    }
    throw error;
  }

  let removed = false;
  if (options.remove && exitCode === 0) {
    const complaint = await removeDelegateWorktree(repoRoot, createdPath, { runGit });
    if (complaint) {
      removed = false;
      const message =
        `git refused to remove the worktree (it may contain uncommitted work):\n  ${complaint.trim().split("\n").join("\n  ")}`;
      if (options.json) {
        emitJson({ name, exitCode, worktree: createdPath, branch, removed: false, note: message });
      } else {
        banner(`[glm-router] ${message}`, options.quiet);
        banner(`[glm-router] worktree kept at ${createdPath}`, options.quiet);
      }
      return exitCode;
    }
    removed = true;
  }

  if (options.json) {
    emitJson({ name, exitCode, worktree: createdPath, branch, removed });
  } else {
    banner(`[glm-router] worker exited ${exitCode}`, options.quiet);
    if (removed) {
      banner(`[glm-router] worktree removed; branch ${branch} kept`, options.quiet);
    } else {
      banner(`[glm-router] worktree kept at ${createdPath}`, options.quiet);
      banner(`[glm-router] next: inspect it, then merge ${branch} (or discard with git worktree remove)`, options.quiet);
    }
  }
  return exitCode;
}
