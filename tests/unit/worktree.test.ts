import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GitResult, RunGit } from "../../src/core/git.js";
import { gitTopLevel, runGit } from "../../src/core/git.js";
import {
  branchExists,
  createDelegateWorktree,
  delegateBranch,
  delegateWorktreePath,
  headIsBorn,
  removeDelegateWorktree,
  validateDelegateName,
  worktreeBaseDir,
} from "../../src/core/worktree.js";
import { makeTempDir, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

const OK: GitResult = { code: 0, stdout: "", stderr: "" };

/**
 * Scripted git runner keyed on the argument shape:
 * `branch`/`head` set the rev-parse --verify answers, `add`/`remove` the
 * worktree-command answers.
 */
function fakeGit(answers: {
  branchExists?: boolean;
  headIsBorn?: boolean;
  add?: GitResult;
  remove?: GitResult;
}): RunGit {
  return async (args) => {
    if (args[0] === "worktree" && args[1] === "add") {
      return answers.add ?? OK;
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      return answers.remove ?? OK;
    }
    if (args.includes("--verify")) {
      if (args[args.length - 1] === "HEAD") {
        return answers.headIsBorn === false ? { ...OK, code: 1 } : OK;
      }
      return answers.branchExists ? OK : { ...OK, code: 1 };
    }
    return OK;
  };
}

describe("validateDelegateName (specs/delegate-worktrees.md)", () => {
  it("accepts slugs used in the roadmap examples", () => {
    for (const name of ["backend", "frontend", "tests", "auth-refresh", "tests.v2", "a_1", "Worker9"]) {
      expect(() => validateDelegateName(name)).not.toThrow();
    }
  });

  it("rejects path traversal, spaces, leading dash, and .git", () => {
    for (const name of ["", "a b", "../evil", "sub/dir", "back\\slash", "-x", ".git", ".", "..", "GLM/DELEGATE/x"]) {
      const error = (() => {
        try {
          validateDelegateName(name);
        } catch (error) {
          return error as { codeName?: string };
        }
        return undefined;
      })();
      expect(error, `name "${name}"`).toMatchObject({ codeName: "INVALID_DELEGATE_NAME" });
    }
  });
});

describe("branch/path derivation", () => {
  it("derives branch and out-of-repo worktree paths from the repo root", () => {
    const root = path.join("D:", "code", "my-repo");
    expect(delegateBranch("backend")).toBe("glm/delegate/backend");
    expect(worktreeBaseDir(root)).toBe(path.join("D:", "code", "my-repo.glm-worktrees"));
    expect(delegateWorktreePath(root, "backend")).toBe(path.join("D:", "code", "my-repo.glm-worktrees", "backend"));
  });
});

describe("branchExists / headIsBorn with an injected runner", () => {
  it("maps exit code 0 to true and non-zero to false", async () => {
    expect(await branchExists("root", "glm/delegate/x", { runGit: fakeGit({ branchExists: true }) })).toBe(true);
    expect(await branchExists("root", "glm/delegate/x", { runGit: fakeGit({}) })).toBe(false);
    expect(await headIsBorn("root", { runGit: fakeGit({ headIsBorn: true }) })).toBe(true);
    expect(await headIsBorn("root", { runGit: fakeGit({ headIsBorn: false }) })).toBe(false);
  });
});

describe("createDelegateWorktree failure paths (injected runner)", () => {
  it("fails with ERROR [31] and an actionable hint when the branch already exists", async () => {
    await expect(
      createDelegateWorktree("root", "backend", { runGit: fakeGit({ branchExists: true }) }),
    ).rejects.toMatchObject({ codeName: "WORKTREE_FAILED", exitCode: 31 });
  });

  it("fails when the worktree directory is already on disk", async () => {
    await expect(
      createDelegateWorktree("root", "backend", { runGit: fakeGit({}), existsSync: () => true }),
    ).rejects.toMatchObject({ codeName: "WORKTREE_FAILED", exitCode: 31 });
  });

  it("suggests an initial commit when HEAD is unborn", async () => {
    const error = (await createDelegateWorktree("root", "backend", {
      runGit: fakeGit({ headIsBorn: false }),
      existsSync: () => false,
    }).catch((error: unknown) => error)) as { codeName: string; hint: readonly string[] };
    expect(error.codeName).toBe("WORKTREE_FAILED");
    expect(error.hint.join("\n")).toContain("git add -A");
  });

  it("wraps git's stderr when worktree add itself fails", async () => {
    await expect(
      createDelegateWorktree("root", "backend", {
        runGit: fakeGit({ add: { code: 128, stdout: "", stderr: "fatal: some git problem" } }),
        existsSync: () => false,
      }),
    ).rejects.toMatchObject({
      codeName: "WORKTREE_FAILED",
      message: expect.stringContaining("some git problem"),
    });
  });
});

describe("removeDelegateWorktree (injected runner)", () => {
  it("returns undefined on success and git's complaint on failure", async () => {
    expect(await removeDelegateWorktree("root", "wt", { runGit: fakeGit({}) })).toBeUndefined();

    const complaint = await removeDelegateWorktree("root", "wt", {
      runGit: fakeGit({ remove: { code: 128, stdout: "", stderr: "fatal: 'wt' contains modified or untracked files" } }),
    });
    expect(complaint).toContain("modified or untracked");
  });
});

describe("real git runner", () => {
  it("runGit resolves with the exit code instead of throwing", async () => {
    const dir = makeTempDir("glm-rungit-fail-");
    try {
      const result = await runGit(["rev-parse", "--show-toplevel"], dir); // not a repo → git exits non-zero
      expect(result.code).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    } finally {
      removeTempDir(dir);
    }
  });

  it("gitTopLevel finds a repo and rejects a plain directory", async () => {
    const dir = makeTempDir("glm-toplevel-");
    try {
      expect(await gitTopLevel(process.cwd())).toBe(path.resolve(process.cwd()));
      expect(await gitTopLevel(dir)).toBeUndefined();

      fs.mkdirSync(dir, { recursive: true });
      writeFileSyncAll(path.join(dir, "a.txt"), "x");
      execFileSync("git", ["init", "-b", "main"], { cwd: dir, windowsHide: true, stdio: "ignore" });
      expect(await gitTopLevel(dir)).toBe(path.resolve(dir));
    } finally {
      removeTempDir(dir);
    }
  });
});
