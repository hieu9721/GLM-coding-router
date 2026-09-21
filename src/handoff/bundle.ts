import fs from "node:fs";
import path from "node:path";
import { logger } from "../core/logging.js";
import { gitTopLevel, runGit } from "../core/git.js";
import type { RunGit } from "../core/git.js";
import { atomicWriteFile } from "../project/atomic-write.js";
import { CHECKPOINT_FILE_NAME, writeCheckpoint } from "../runs/checkpoint.js";
import type { Checkpoint } from "../runs/checkpoint.js";

/** Where the bundle lands: `<runDir>/handoff/` (doc §17). */
export const HANDOFF_DIR_NAME = "handoff";

/** The one provider v2 knows (H2/D5), hardcoded into the H5 handoff block. */
const ZAI_PROVIDER = "zai.zcode";

/** H5: v3 §18's cross-provider handoff targets the orchestrator, by name. */
const ORCHESTRATOR_PROVIDER = "anthropic.claude-code";

/**
 * What `writeHandoffBundle` produced: absolute paths to the four bundle files
 * (doc §17). `diffPatch` is null exactly when there is no diff — cwd not a git
 * repo, or the git call itself failed. Paths for files whose individual write
 * failed are still reported: a degraded section is logged at debug and must not
 * abort the bundle, and the caller prints these paths either way.
 */
export interface HandoffBundle {
  readonly dir: string;
  readonly handoffMd: string;
  readonly handoffJson: string;
  readonly checkpointJson: string;
  readonly diffPatch: string | null;
}

/** Inputs for {@link writeHandoffBundle}. */
export interface HandoffBundleInput {
  readonly runDir: string;
  readonly runId: string;
  /** The worker's working directory — where the git questions are asked. */
  readonly cwd: string;
  /** Why the run came back unfinished, e.g. "quota_low" or "child_error". */
  readonly reason: string;
  readonly checkpoint: Checkpoint;
  readonly role: "worker" | "reviewer";
  readonly model: string;
  /** Injectable git runner; defaults to the real one. */
  readonly runGit?: RunGit;
}

/** The git-derived workspace facts H5 wants; all null when cwd is not a repo. */
interface WorkspaceInfo {
  readonly isRepo: boolean;
  /** Basename of the repo/worktree root. */
  readonly repo: string | null;
  /** Absolute worktree root — for a linked worktree, `rev-parse --show-toplevel` IS that worktree. */
  readonly worktree: string | null;
  /** Current branch; null when detached or unreadable. */
  readonly branch: string | null;
  /** `??` entries from `git status --porcelain` — files `git diff` cannot show. */
  readonly untracked: readonly string[];
}

/**
 * Writes the handoff bundle (doc §17): `checkpoint.json`, `diff.patch`,
 * `handoff.md`, `handoff.json` under `<runDir>/handoff/`.
 *
 * **Never fails the run.** Returns null only when the bundle directory itself
 * cannot be created; every git call and every file write is individually
 * guarded, so one degraded section (no diff, no branch, a lost file) becomes a
 * debug log while the rest of the bundle still reaches disk. The caller prints
 * the bundle path and carries on regardless — the work on disk is the thing
 * being rescued here, and it is already safe.
 *
 * `diff.patch` is plain `git diff` — tracked changes only, never `git add`
 * (this repo's no-automatic-git rule is exactly why untracked files get their
 * own heading in `handoff.md` instead of being staged into the diff). Plain
 * `git diff` rather than `git diff HEAD` deliberately: the router never stages
 * anything, and on an unborn HEAD `git diff` still exits 0 where `HEAD` would
 * fail and needlessly drop the diff section.
 *
 * C3: every task-derived string here (title, completed lines, validation
 * commands, file paths) comes from the checkpoint, whose fields were already
 * redacted and capped upstream. No prompt body, tool result or LLM response is
 * ever read, and nothing from the environment is written.
 */
export async function writeHandoffBundle(input: HandoffBundleInput): Promise<HandoffBundle | null> {
  const dir = path.join(input.runDir, HANDOFF_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    logger.debug(`handoff bundle: creating ${dir} failed: ${errorMessage(error)}`);
    return null;
  }

  const handoffMd = path.join(dir, "handoff.md");
  const handoffJson = path.join(dir, "handoff.json");
  const checkpointJson = path.join(dir, CHECKPOINT_FILE_NAME);
  const diffFile = path.join(dir, "diff.patch");

  const git = input.runGit ?? runGit;
  const workspace = await workspaceInfo(input.cwd, git);
  const diff = workspace.isRepo ? await trackedDiff(input.cwd, git) : null;
  const diffPatch = diff !== null && guardedWrite(diffFile, diff) ? diffFile : null;

  // Reuses the never-throwing writer so the bundle's copy is byte-identical to
  // the one the run directory itself may already hold.
  writeCheckpoint(dir, input.checkpoint);

  guardedWrite(handoffMd, renderMarkdown(input, workspace, diffPatch !== null));

  guardedWrite(
    handoffJson,
    JSON.stringify(
      {
        // Doc §18's shape, verbatim in key order...
        status: "handoff_required",
        run_id: input.runId,
        reason: input.reason,
        completed: input.checkpoint.completed,
        pending: input.checkpoint.pending,
        handoff_path: handoffMd,
        // ...then hedge H5: v3 §17's from/to and v4 §20's workspace block, so
        // a v2 bundle stays readable by v3/v4 without a migration pass.
        from: { provider: ZAI_PROVIDER, role: input.role },
        to: { provider: ORCHESTRATOR_PROVIDER, role: "orchestrator" },
        workspace: { repo: workspace.repo, worktree: workspace.worktree, branch: workspace.branch },
        bundle: { checkpoint: checkpointJson, diff: diffPatch, markdown: handoffMd },
      },
      null,
      2,
    ) + "\n",
  );

  return { dir, handoffMd, handoffJson, checkpointJson, diffPatch };
}

/**
 * Everything C3 allows a human to read: the title (the checkpoint's first
 * pending entry), the run id and reason, done/remaining/files/validation from
 * the checkpoint, and the git facts. Untracked files get their OWN heading
 * because they are invisible to `diff.patch` — a reader who assumes the patch
 * is the whole story silently loses them.
 */
function renderMarkdown(
  input: HandoffBundleInput,
  workspace: WorkspaceInfo,
  diffWritten: boolean,
): string {
  const checkpoint = input.checkpoint;
  const title = checkpoint.pending.length > 0 ? checkpoint.pending[0] : "continue the task";
  const workspaceLine = workspace.isRepo
    ? `${workspace.repo ?? "?"} on ${workspace.branch ?? "(detached HEAD)"} — ${workspace.worktree ?? input.cwd}`
    : "not a git repository";

  const lines: string[] = [
    `# Handoff: ${title}`,
    "",
    `- Run: ${input.runId}`,
    `- Reason: ${input.reason}`,
    `- Role: ${input.role} (model ${input.model})`,
    `- Workspace: ${workspaceLine}`,
    "",
    "## Done",
    ...bullets(checkpoint.completed, "(no completed turns recorded)"),
    "",
    "## Remaining",
    ...bullets(checkpoint.pending, "(nothing recorded — see the run's events)"),
    "",
    "## Files changed",
    ...bullets(checkpoint.filesChanged, "(none)"),
  ];

  if (workspace.isRepo) {
    // The heading is the warning: these files are NOT inside diff.patch.
    lines.push("", "## Untracked files (not in diff.patch)", ...bullets(workspace.untracked, "(none)"));
  }

  lines.push(
    "",
    "## Validation still owed",
    ...bullets(checkpoint.validationPending, "(none)"),
    "",
    "## Diff",
  );
  if (!workspace.isRepo) {
    lines.push("Not a git repository — no `diff.patch` was written.");
  } else if (!diffWritten) {
    lines.push("Tracked changes could not be captured — `diff.patch` was not written. Run `git diff` yourself.");
  } else {
    lines.push("Tracked changes are in `diff.patch`. Untracked files are the ones listed above, not in the patch.");
  }

  lines.push(
    "",
    "## Next step",
    "",
    `Continue the task in the same worktree (\`${input.cwd}\`) — pick up from "Remaining" above instead of re-running the worker from scratch.`,
    "",
  );
  return lines.join("\n");
}

function bullets(items: readonly string[], empty: string): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${empty}`];
}

/** One guard per git question, so a broken answer degrades alone. */
async function workspaceInfo(cwd: string, git: RunGit): Promise<WorkspaceInfo> {
  let topLevel: string | undefined;
  try {
    // gitTopLevel rejects (rather than resolving) when git itself is missing,
    // so even repo detection is inside the guard.
    topLevel = await gitTopLevel(cwd, git);
  } catch (error) {
    logger.debug(`handoff bundle: repo detection in ${cwd} failed: ${errorMessage(error)}`);
    topLevel = undefined;
  }
  if (topLevel === undefined) {
    return { isRepo: false, repo: null, worktree: null, branch: null, untracked: [] };
  }

  const branch = await currentBranch(cwd, git);
  const untracked = await untrackedFiles(cwd, git);
  return { isRepo: true, repo: path.basename(topLevel), worktree: topLevel, branch, untracked };
}

async function currentBranch(cwd: string, git: RunGit): Promise<string | null> {
  try {
    const result = await git(["branch", "--show-current"], cwd);
    if (result.code !== 0) {
      logger.debug(`handoff bundle: branch lookup in ${cwd} exited ${result.code}`);
      return null;
    }
    // Empty output is a detached HEAD — truthful as null, not as "".
    const branch = result.stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch (error) {
    logger.debug(`handoff bundle: branch lookup in ${cwd} failed: ${errorMessage(error)}`);
    return null;
  }
}

async function untrackedFiles(cwd: string, git: RunGit): Promise<string[]> {
  try {
    const result = await git(["status", "--porcelain", "-z"], cwd);
    if (result.code !== 0) {
      logger.debug(`handoff bundle: status in ${cwd} exited ${result.code}`);
      return [];
    }
    // -z: NUL-terminated, unquoted — spaces in filenames survive intact.
    return result.stdout
      .split("\0")
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3));
  } catch (error) {
    logger.debug(`handoff bundle: status in ${cwd} failed: ${errorMessage(error)}`);
    return [];
  }
}

async function trackedDiff(cwd: string, git: RunGit): Promise<string | null> {
  try {
    const result = await git(["diff"], cwd);
    if (result.code !== 0) {
      logger.debug(`handoff bundle: git diff in ${cwd} exited ${result.code}`);
      return null;
    }
    return result.stdout;
  } catch (error) {
    logger.debug(`handoff bundle: git diff in ${cwd} failed: ${errorMessage(error)}`);
    return null;
  }
}

function guardedWrite(file: string, content: string): boolean {
  try {
    atomicWriteFile(file, content);
    return true;
  } catch (error) {
    logger.debug(`handoff bundle: writing ${file} failed: ${errorMessage(error)}`);
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
