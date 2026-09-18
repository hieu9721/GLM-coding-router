import fs from "node:fs";
import path from "node:path";
import { runGit, type GitResult, type RunGit } from "./git.js";
import { Errors } from "./errors.js";
import { logger } from "./logging.js";

/** Branch prefix for delegate worktrees (specs/delegate-worktrees.md). */
export const DELEGATE_BRANCH_PREFIX = "glm/delegate/";

export interface GitDeps {
  /** Defaults to the real git runner; injectable for tests. */
  readonly runGit?: RunGit;
  /** Used for the leftover-directory pre-check; injectable for tests. */
  readonly existsSync?: (path: string) => boolean;
}

/** Valid delegate slugs: no path separators, spaces, or leading dash (specs/delegate-worktrees.md). */
export function validateDelegateName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "." || name === ".." || name.toLowerCase() === ".git") {
    throw Errors.invalidDelegateName(name);
  }
}

export function delegateBranch(name: string): string {
  return `${DELEGATE_BRANCH_PREFIX}${name}`;
}

/**
 * Worktrees live outside the repo so the main checkout's status stays clean
 * and no .gitignore edit is ever needed: <parent-of-root>/<repo>.glm-worktrees/<name>
 */
export function worktreeBaseDir(repoRoot: string): string {
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}.glm-worktrees`);
}

export function delegateWorktreePath(repoRoot: string, name: string): string {
  return path.join(worktreeBaseDir(repoRoot), name);
}

function ok(result: GitResult): boolean {
  return result.code === 0;
}

/** True when a local branch already exists (rev-parse --verify --quiet). */
export async function branchExists(repoRoot: string, branch: string, deps: GitDeps = {}): Promise<boolean> {
  const run = deps.runGit ?? runGit;
  const result = await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
  return ok(result);
}

/** True when HEAD resolves (the repo has at least one commit). */
export async function headIsBorn(repoRoot: string, deps: GitDeps = {}): Promise<boolean> {
  const run = deps.runGit ?? runGit;
  const result = await run(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot);
  return ok(result);
}

/**
 * Pre-flight collision checks shared by the real run and --dry-run
 * (specs/delegate-worktrees.md): fail before creating anything.
 */
export async function assertWorktreeAvailable(repoRoot: string, name: string, deps: GitDeps = {}): Promise<string> {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const branch = delegateBranch(name);
  const worktreePath = delegateWorktreePath(repoRoot, name);

  if (await branchExists(repoRoot, branch, deps)) {
    throw Errors.worktreeFailed(
      "branch",
      `branch ${branch} already exists`,
      [
        "Inspect or merge it first:",
        "",
        `  git log ${branch}`,
        `  git merge ${branch}`,
        "",
        `or delete it if it is unwanted:`,
        "",
        `  git branch -D ${branch}`,
      ],
    );
  }
  if (existsSync(worktreePath)) {
    throw Errors.worktreeFailed(
      "worktree add",
      `path already exists: ${worktreePath}`,
      [
        "A previous worktree directory is in the way:",
        "",
        `  ${worktreePath}`,
        "",
        "Remove it (or run `git worktree prune`) and re-run the delegate command.",
      ],
    );
  }
  if (!(await headIsBorn(repoRoot, deps))) {
    throw Errors.worktreeFailed(
      "worktree add",
      "HEAD does not point at a commit (repository has no commits yet)",
      [
        "delegate creates the worktree from HEAD, so the repository needs at least one commit first:",
        "",
        "  git add -A && git commit -m \"initial commit\"",
      ],
    );
  }
  return worktreePath;
}

/** Create the delegate worktree + branch from HEAD. Returns the worktree path. */
export async function createDelegateWorktree(repoRoot: string, name: string, deps: GitDeps = {}): Promise<string> {
  const run = deps.runGit ?? runGit;
  const worktreePath = await assertWorktreeAvailable(repoRoot, name, deps);
  const branch = delegateBranch(name);
  logger.debug(`git worktree add -b ${branch} ${worktreePath}`);
  const result = await run(["worktree", "add", "-b", branch, worktreePath], repoRoot);
  if (!ok(result)) {
    throw Errors.worktreeFailed(
      "worktree add",
      result.stderr || result.stdout,
      ["The worktree was not created; the repository was left as it was."],
    );
  }
  return worktreePath;
}

/**
 * Remove a delegate worktree with plain `git worktree remove` — git refuses
 * on dirty/untracked trees, which is exactly the safety we want
 * (specs/delegate-worktrees.md, `--remove`). Never touches the branch.
 * Returns undefined when removal succeeded, or git's complaint when not.
 */
export async function removeDelegateWorktree(
  repoRoot: string,
  worktreePath: string,
  deps: GitDeps = {},
): Promise<string | undefined> {
  const run = deps.runGit ?? runGit;
  const result = await run(["worktree", "remove", worktreePath], repoRoot);
  if (ok(result)) {
    return undefined;
  }
  return result.stderr || result.stdout || "git worktree remove failed";
}

/**
 * Delete a branch this invocation created and never advanced (worker never
 * started). Only ever called on the spawn-failure rollback path, where the
 * branch provably sits at HEAD — never on branches a worker may have moved.
 */
export async function rollbackDelegateBranch(
  repoRoot: string,
  branch: string,
  deps: GitDeps = {},
): Promise<string | undefined> {
  const run = deps.runGit ?? runGit;
  const result = await run(["branch", "-D", branch], repoRoot);
  if (ok(result)) {
    return undefined;
  }
  return result.stderr || result.stdout || "git branch -D failed";
}
