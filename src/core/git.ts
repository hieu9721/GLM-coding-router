import { execFile } from "node:child_process";
import path from "node:path";
import { Errors } from "./errors.js";

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable git runner (specs/delegate-worktrees.md): argument array, parent env, never a shell. */
export type RunGit = (args: readonly string[], cwd: string) => Promise<GitResult>;

function isENOENT(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Real git runner: resolves with the exit code instead of throwing on failure. */
export const runGit: RunGit = (args, cwd) =>
  new Promise<GitResult>((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && isENOENT(error)) {
          reject(Errors.gitNotFound());
          return;
        }
        const code = error && typeof (error as NodeJS.ErrnoException).code === "number"
          ? (error as unknown as { code: number }).code
          : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });

/**
 * Strict repo-root lookup for delegate (specs/delegate-worktrees.md):
 * unlike findProjectRoot, undefined when cwd is not inside a git repo.
 */
export async function gitTopLevel(cwd: string, run: RunGit = runGit): Promise<string | undefined> {
  const result = await run(["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0) {
    return undefined;
  }
  const root = result.stdout.trim();
  return root.length > 0 ? path.resolve(root) : undefined;
}
