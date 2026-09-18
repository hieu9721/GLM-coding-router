import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delegateCommand, type SpawnWorker } from "../../src/commands/delegate.js";
import { defaultConfig } from "../../src/core/config.js";
import { createGlmEnv } from "../../src/core/env.js";
import { spawnAgent } from "../../src/core/process.js";
import { WORKER_TOOLS } from "../../src/bin/glm-worker.js";
import {
  createDelegateWorktree,
  delegateWorktreePath,
  worktreeBaseDir,
} from "../../src/core/worktree.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));
const NODE = process.execPath;

let dirs: string[] = [];
let repos: string[] = [];

afterEach(() => {
  for (const repo of repos) removeTempDir(worktreeBaseDir(path.resolve(repo))); // worktrees live outside the repo
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  repos = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-delegate-cmd-");
  dirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

/** Real git repo with one commit on main. */
function makeRepo(): string {
  const repo = temp();
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSyncAll(path.join(repo, "README.md"), "# test\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "init"], repo);
  repos.push(repo);
  return repo;
}

/** Home whose config points claudePath at node.exe (a real file, never actually spawned). */
function makeHome(profiles?: Record<string, object>): string {
  const home = temp();
  const config = { ...defaultConfig(), claudePath: NODE, ...(profiles ? { profiles } : {}) };
  writeFileSyncAll(path.join(home, ".glm-coding-router", "config.json"), JSON.stringify(config));
  return home;
}

interface RecordedSpawn {
  readonly binPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

function recorderSpawn(
  exitCode = 0,
  sideEffect?: (cwd: string) => void,
): { spawn: SpawnWorker; calls: RecordedSpawn[] } {
  const calls: RecordedSpawn[] = [];
  const spawn: SpawnWorker = async (binPath, options) => {
    calls.push({ binPath, args: options.args, cwd: options.cwd, env: options.env });
    if (sideEffect) sideEffect(options.cwd);
    return exitCode;
  };
  return { spawn, calls };
}

function baseDeps(repo: string, home: string, spawn: SpawnWorker) {
  return {
    cwd: repo,
    home,
    env: { ZAI_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    readStdinFn: () => Promise.resolve(undefined),
    spawn,
  };
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

function worktreeOf(repo: string, name: string): string {
  return delegateWorktreePath(path.resolve(repo), name);
}

function branchList(repo: string, branch: string): string {
  return git(["branch", "--list", branch], path.resolve(repo));
}

describe("delegateCommand happy path (specs/delegate-worktrees.md)", () => {
  it("creates the worktree + branch, spawns the worker inside it, keeps both, returns the code", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const { spawn, calls } = recorderSpawn(0);
    const out = captureStdout();

    const code = await delegateCommand("backend", ["do stuff"], {}, baseDeps(repo, home, spawn));

    expect(code).toBe(0);
    const wt = worktreeOf(repo, "backend");
    expect(fs.existsSync(wt)).toBe(true);
    expect(readText(path.join(wt, "README.md")).trim()).toBe("# test"); // worktree checked out from HEAD
    expect(branchList(repo, "glm/delegate/backend")).toContain("glm/delegate/backend");

    expect(calls.length).toBe(1);
    expect(calls[0].cwd).toBe(wt);
    expect(calls[0].args).toEqual([
      "-p",
      "do stuff",
      "--max-turns",
      "20",
      "--permission-mode",
      "acceptEdits",
      "--tools",
      WORKER_TOOLS,
    ]);
    expect(calls[0].env.ANTHROPIC_AUTH_TOKEN).toBe("test-key");
    expect(calls[0].env.ANTHROPIC_API_KEY).toBe("");
    expect(calls[0].env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(out.text()).toContain("worktree kept");
    expect(out.text()).not.toContain("test-key");
  });

  it("two delegates with different names coexist", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const a = recorderSpawn(0);
    const b = recorderSpawn(0);

    await delegateCommand("backend", ["a"], {}, baseDeps(repo, home, a.spawn));
    await delegateCommand("tests", ["b"], {}, baseDeps(repo, home, b.spawn));

    expect(fs.existsSync(worktreeOf(repo, "backend"))).toBe(true);
    expect(fs.existsSync(worktreeOf(repo, "tests"))).toBe(true);
    expect(a.calls[0].cwd).not.toBe(b.calls[0].cwd);
  });

  it("propagates the worker's non-zero exit code and still keeps the worktree", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const { spawn } = recorderSpawn(3);

    const code = await delegateCommand("backend", ["x"], {}, baseDeps(repo, home, spawn));

    expect(code).toBe(3);
    expect(fs.existsSync(worktreeOf(repo, "backend"))).toBe(true);
  });
});

describe("delegateCommand collision and repo errors", () => {
  it("second delegate with the same name fails ERROR [31] before creating anything", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const { spawn } = recorderSpawn(0);
    await delegateCommand("backend", ["x"], {}, baseDeps(repo, home, spawn));

    await expect(delegateCommand("backend", ["x"], {}, baseDeps(repo, home, spawn))).rejects.toMatchObject({
      codeName: "WORKTREE_FAILED",
      exitCode: 31,
    });
  });

  it("a leftover worktree directory blocks the run with the path in the message", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const wt = worktreeOf(repo, "backend");
    writeFileSyncAll(path.join(wt, "stale.txt"), "x");

    await expect(delegateCommand("backend", ["x"], {}, baseDeps(repo, home, recorderSpawn(0).spawn))).rejects.toMatchObject(
      { codeName: "WORKTREE_FAILED", message: expect.stringContaining("already exists") },
    );
  });

  it("outside a git repository → ERROR [30] GIT_REPO_REQUIRED", async () => {
    const dir = temp();
    const home = makeHome();
    await expect(delegateCommand("backend", ["x"], {}, baseDeps(dir, home, recorderSpawn(0).spawn))).rejects.toMatchObject(
      { codeName: "GIT_REPO_REQUIRED", exitCode: 30 },
    );
  });

  it("a repository without commits → ERROR [31] with an initial-commit hint", async () => {
    const repo = temp();
    git(["init", "-b", "main"], repo);
    const home = makeHome();

    const error = (await delegateCommand("backend", ["x"], {}, baseDeps(repo, home, recorderSpawn(0).spawn)).catch(
      (error: unknown) => error,
    )) as { codeName: string; hint: readonly string[] };
    expect(error.codeName).toBe("WORKTREE_FAILED");
    expect(error.hint.join("\n")).toContain("git add -A");
  });

  it("invalid name → ERROR [2]; missing prompt → ERROR [2] PROMPT_REQUIRED", async () => {
    const repo = makeRepo();
    const home = makeHome();
    await expect(delegateCommand("a b", ["x"], {}, baseDeps(repo, home, recorderSpawn(0).spawn))).rejects.toMatchObject({
      codeName: "INVALID_DELEGATE_NAME",
      exitCode: 2,
    });

    await expect(delegateCommand("backend", [], {}, baseDeps(repo, home, recorderSpawn(0).spawn))).rejects.toMatchObject({
      codeName: "PROMPT_REQUIRED",
      exitCode: 2,
    });
  });

  it("rolls the worktree and branch back when the worker fails to spawn at all", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const spawn: SpawnWorker = async () => {
      throw new Error("spawn exploded");
    };

    await expect(delegateCommand("backend", ["x"], {}, baseDeps(repo, home, spawn))).rejects.toThrowError(
      "spawn exploded",
    );
    expect(fs.existsSync(worktreeOf(repo, "backend"))).toBe(false);
    expect(branchList(repo, "glm/delegate/backend")).toBe("");
  });
});

describe("delegateCommand --remove (specs/delegate-worktrees.md)", () => {
  it("removes a clean worktree after success but always keeps the branch", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const out = captureStdout();

    const code = await delegateCommand("backend", ["x"], { remove: true }, baseDeps(repo, home, recorderSpawn(0).spawn));

    expect(code).toBe(0);
    expect(fs.existsSync(worktreeOf(repo, "backend"))).toBe(false);
    expect(branchList(repo, "glm/delegate/backend")).toContain("glm/delegate/backend");
    expect(out.text()).toContain("worktree removed");
  });

  it("keeps the worktree when git refuses (worker left changes behind)", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const out = captureStdout();
    const { spawn } = recorderSpawn(0, (cwd) => writeFileSyncAll(path.join(cwd, "new-file.ts"), "x"));

    const code = await delegateCommand("backend", ["x"], { remove: true }, baseDeps(repo, home, spawn));

    expect(code).toBe(0);
    expect(fs.existsSync(worktreeOf(repo, "backend"))).toBe(true);
    expect(out.text()).toContain("refused");
  });

  it("does not remove after a failed worker run", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const { spawn } = recorderSpawn(1);

    const code = await delegateCommand("backend", ["x"], { remove: true }, baseDeps(repo, home, spawn));

    expect(code).toBe(1);
    expect(fs.existsSync(worktreeOf(repo, "backend"))).toBe(true);
  });
});

describe("delegateCommand profiles and output modes", () => {
  it("applies a profile literally named after the delegate when --profile is absent", async () => {
    const repo = makeRepo();
    const home = makeHome({ backend: { workerMaxTurns: 7 } });
    const { spawn, calls } = recorderSpawn(0);

    await delegateCommand("backend", ["x"], {}, baseDeps(repo, home, spawn));

    expect(calls[0].args).toContain("7");
    expect(calls[0].args).not.toContain("20");
  });

  it("an explicit unknown profile → ERROR [11]", async () => {
    const repo = makeRepo();
    const home = makeHome();
    await expect(
      delegateCommand("backend", ["x"], { profile: "nope" }, baseDeps(repo, home, recorderSpawn(0).spawn)),
    ).rejects.toMatchObject({ codeName: "CONFIG_INVALID", exitCode: 11 });
  });

  it("dry-run creates nothing and prints the plan", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const out = captureStdout();

    const code = await delegateCommand("backend", ["x"], { dryRun: true }, baseDeps(repo, home, recorderSpawn(0).spawn));

    expect(code).toBe(0);
    expect(out.text()).toContain("would create worktree");
    expect(fs.existsSync(worktreeOf(repo, "backend"))).toBe(false);
    expect(fs.existsSync(worktreeBaseDir(path.resolve(repo)))).toBe(false);
    expect(branchList(repo, "glm/delegate/backend")).toBe("");
  });

  it("--json emits valid pre-flight and result objects and never the key", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const out = captureStdout();

    const code = await delegateCommand("backend", ["x"], { json: true }, baseDeps(repo, home, recorderSpawn(0).spawn));

    expect(code).toBe(0);
    const text = out.text();
    expect(text).not.toContain("test-key");
    // emitJson pretty-prints, so extract each top-level {...} block and parse it.
    const objects = [...text.matchAll(/\{[^{}]*\}/gs)].map((match) => JSON.parse(match[0]) as Record<string, unknown>);
    expect(objects).toHaveLength(2);
    expect(objects[0]).toMatchObject({ name: "backend", branch: "glm/delegate/backend" });
    expect(objects[1]).toMatchObject({ exitCode: 0, removed: false });
  });
});

describe("real spawn glue inside a delegate worktree", () => {
  it("spawns the fake agent with cwd inside the worktree and the GLM env", async () => {
    const repo = makeRepo();
    const wt = await createDelegateWorktree(path.resolve(repo), "real");
    const outFile = path.join(temp(), "dump.json");
    const env = { ...createGlmEnv(defaultConfig(), "k", {}), GLM_TEST_OUTPUT: outFile };

    const code = await spawnAgent(NODE, { args: [FIXTURE], cwd: wt, env, interactive: false });

    expect(code).toBe(0);
    const dump = JSON.parse(readText(outFile)) as { cwd: string; env: Record<string, string | undefined> };
    expect(path.resolve(dump.cwd)).toBe(path.resolve(wt));
    expect(dump.env.ANTHROPIC_AUTH_TOKEN).toBe("k");
    expect(dump.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.3");
  });
});
