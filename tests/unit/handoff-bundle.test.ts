import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunGit } from "../../src/core/git.js";
import { writeHandoffBundle } from "../../src/handoff/bundle.js";
import type { HandoffBundle, HandoffBundleInput } from "../../src/handoff/bundle.js";
import type { Checkpoint } from "../../src/runs/checkpoint.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

const RUN_ID = "run_handoff_fixture_01";

/** Real git, but quiet: fixture setup only — the ROUTER never stages anything. */
function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd, windowsHide: true, stdio: "ignore" });
}

function makeCheckpoint(): Checkpoint {
  return {
    runId: RUN_ID,
    phase: "implementation",
    completed: ["turn 1: Read src/a.ts", "turn 2: Edit src/b.ts"],
    pending: ["Wire the quota probe", "npm test"],
    filesChanged: ["src/b.ts"],
    validationPending: ["npm test"],
  };
}

function bundleInput(runDir: string, cwd: string, overrides: Partial<HandoffBundleInput> = {}): HandoffBundleInput {
  return {
    runDir,
    runId: RUN_ID,
    cwd,
    reason: "quota_low",
    checkpoint: makeCheckpoint(),
    role: "worker",
    model: "glm-5.3",
    ...overrides,
  };
}

describe("writeHandoffBundle (specs/v2-architecture.md Phase F, doc §17)", () => {
  it("diff.patch carries the tracked change; handoff.md lists the untracked file separately", async () => {
    const repo = makeTempDir("glm-handoff-repo-");
    const runDir = makeTempDir("glm-handoff-rundir-");
    try {
      git(repo, ["init", "-b", "main"]);
      writeFileSyncAll(path.join(repo, "tracked.txt"), "one\n");
      git(repo, ["add", "tracked.txt"]);
      git(repo, ["-c", "user.name=glm-router-test", "-c", "user.email=test@glm-router.invalid", "commit", "-m", "init"]);
      // Exactly what a half-finished worker leaves: a tracked file modified,
      // and a new file git has never been told about.
      writeFileSyncAll(path.join(repo, "tracked.txt"), "one\ntwo\n");
      writeFileSyncAll(path.join(repo, "untracked-note.md"), "brand new\n");

      // No runGit injection: this test is the one that exercises the real one.
      const bundle = await writeHandoffBundle(bundleInput(runDir, repo));
      expect(bundle).not.toBeNull();
      const b: HandoffBundle = bundle!;

      expect(b.dir).toBe(path.join(runDir, "handoff"));
      expect(b.diffPatch).toBe(path.join(runDir, "handoff", "diff.patch"));
      const diff = readText(b.diffPatch ?? "");
      expect(diff).toContain("+two");
      // Untracked files are NOT in the patch — that is the whole reason they
      // get their own heading in handoff.md.
      expect(diff).not.toContain("untracked-note.md");

      expect(JSON.parse(readText(b.checkpointJson))).toEqual(makeCheckpoint());

      const md = readText(b.handoffMd);
      expect(md).toContain("# Handoff: Wire the quota probe");
      expect(md).toContain(RUN_ID);
      expect(md).toContain("quota_low");
      expect(md).toContain("turn 2: Edit src/b.ts");
      expect(md).toContain("npm test");
      expect(md).toContain("## Untracked files (not in diff.patch)");
      expect(md).toContain("- untracked-note.md");
      expect(md).toContain("same worktree");

      const json = JSON.parse(readText(b.handoffJson)) as Record<string, unknown>;
      expect(json).toMatchObject({
        status: "handoff_required",
        run_id: RUN_ID,
        reason: "quota_low",
        handoff_path: b.handoffMd,
        completed: ["turn 1: Read src/a.ts", "turn 2: Edit src/b.ts"],
        pending: ["Wire the quota probe", "npm test"],
        // Hedge H5: the v3 §17 / v4 §20 block, from day one.
        from: { provider: "zai.zcode", role: "worker" },
        to: { provider: "anthropic.claude-code", role: "orchestrator" },
      });
      const workspace = json.workspace as Record<string, unknown>;
      expect(workspace.repo).toBe(path.basename(repo));
      expect(workspace.branch).toBe("main");
      expect(workspace.worktree).toBe(path.resolve(repo));
      expect(json.bundle).toEqual({ checkpoint: b.checkpointJson, diff: b.diffPatch, markdown: b.handoffMd });
    } finally {
      removeTempDir(repo);
      removeTempDir(runDir);
    }
  });

  it("outside a git repo the bundle still exists, diff.patch is omitted, and handoff.md says so", async () => {
    const plain = makeTempDir("glm-handoff-norepo-");
    const runDir = makeTempDir("glm-handoff-rundir-");
    try {
      writeFileSyncAll(path.join(plain, "note.txt"), "just files, no git\n");

      const bundle = await writeHandoffBundle(bundleInput(runDir, plain));

      expect(bundle).not.toBeNull();
      const b = bundle!;
      expect(b.diffPatch).toBeNull();
      expect(fs.existsSync(path.join(b.dir, "diff.patch"))).toBe(false);
      expect(fs.existsSync(b.handoffMd)).toBe(true);
      expect(fs.existsSync(b.handoffJson)).toBe(true);
      expect(fs.existsSync(b.checkpointJson)).toBe(true);

      const md = readText(b.handoffMd);
      // Says so explicitly instead of silently omitting the diff section.
      expect(md).toContain("not a git repository");
      // No repo → no untracked list to fabricate.
      expect(md).not.toContain("## Untracked files");
      expect(md).toContain("same worktree");

      const json = JSON.parse(readText(b.handoffJson)) as Record<string, unknown>;
      expect(json.workspace).toEqual({ repo: null, worktree: null, branch: null });
      expect(json.bundle).toEqual({ checkpoint: b.checkpointJson, diff: null, markdown: b.handoffMd });
    } finally {
      removeTempDir(plain);
      removeTempDir(runDir);
    }
  });

  it("a git runner that fails or throws degrades its sections without failing the bundle", async () => {
    const runDir = makeTempDir("glm-handoff-gitfail-");
    try {
      const failing: RunGit = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
      const fromFailure = await writeHandoffBundle(bundleInput(runDir, path.join("nowhere", "special"), { runGit: failing }));
      expect(fromFailure).not.toBeNull();
      expect(fromFailure!.diffPatch).toBeNull();
      expect(fs.existsSync(fromFailure!.handoffMd)).toBe(true);

      // gitTopLevel REJECTS when git itself is missing; the guard must swallow
      // even a thrown error, not just a non-zero exit.
      const throwing: RunGit = async () => {
        throw new Error("git.exe not found");
      };
      const fromThrow = await writeHandoffBundle(bundleInput(runDir, path.join("nowhere", "special"), { runGit: throwing }));
      expect(fromThrow).not.toBeNull();
      expect(fromThrow!.diffPatch).toBeNull();
      expect(readText(fromThrow!.handoffMd)).toContain("not a git repository");
    } finally {
      removeTempDir(runDir);
    }
  });

  it("returns null only when the bundle directory itself cannot be created", async () => {
    const tmp = makeTempDir("glm-handoff-null-");
    try {
      const runDirIsAFile = path.join(tmp, "run.txt");
      writeFileSyncAll(runDirIsAFile, "occupied");

      const bundle = await writeHandoffBundle(bundleInput(runDirIsAFile, tmp));

      expect(bundle).toBeNull();
    } finally {
      removeTempDir(tmp);
    }
  });
});
