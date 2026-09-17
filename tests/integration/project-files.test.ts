import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { findProjectRoot } from "../../src/project/project-root.js";
import { atomicWriteFile } from "../../src/project/atomic-write.js";
import { removeManagedFile } from "../../src/project/managed-file.js";
import { forgetFile, isOwnedFile, recordCreatedFile } from "../../src/project/ownership.js";
import { installClaudeIntegration, removeClaudeIntegration } from "../../src/integrations/claude.js";
import { installCodexIntegration } from "../../src/integrations/codex.js";
import { CodexSkillInstaller, glmDelegationSkill } from "../../src/integrations/skill.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
});

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}

describe("findProjectRoot (spec §19)", () => {
  it("uses git rev-parse --show-toplevel when available", () => {
    const root = temp();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const nested = path.join(root, "a", "b");
    writeFileSyncAll(path.join(nested, "note.txt"), "x");
    expect(findProjectRoot(nested)).toBe(path.resolve(root));
  });

  it("falls back to cwd outside a git repo", () => {
    const isolated = temp();
    expect(findProjectRoot(isolated)).toBe(isolated);
  });
});

describe("atomicWriteFile (spec §22)", () => {
  it("replaces existing content and leaves no tmp files", () => {
    const dir = temp();
    const file = path.join(dir, "config.json");
    atomicWriteFile(file, "one");
    atomicWriteFile(file, "two");
    expect(readText(file)).toBe("two");
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
  });

  it("creates parent directories", () => {
    const dir = temp();
    const file = path.join(dir, "deep", "nested", "SKILL.md");
    atomicWriteFile(file, "content");
    expect(readText(file)).toBe("content");
  });
});

describe("managed files + ownership (spec §43, §46)", () => {
  it("project init is idempotent: second run is a no-op", () => {
    const root = temp();
    const first = installClaudeIntegration(root);
    expect(first.created).toBe(true);
    expect(first.changed).toBe(true);
    const second = installClaudeIntegration(root);
    expect(second.created).toBe(false);
    expect(second.changed).toBe(false);
    expect(readText(second.file)).toBe(readText(first.file));
  });

  it("removal deletes a router-created file and forgets ownership", () => {
    const home = temp();
    const root = temp();
    installClaudeIntegration(root, { home });
    const file = path.join(root, "CLAUDE.md");
    expect(isOwnedFile(file, home)).toBe(true);
    const change = removeClaudeIntegration(root, { home });
    expect(change.deleted).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(isOwnedFile(file, home)).toBe(false);
  });

  it("removal preserves user files even when only the block remains", () => {
    const home = temp();
    const root = temp();
    const file = path.join(root, "CLAUDE.md");
    writeFileSyncAll(file, "# Mine\n");
    const change = removeManagedFile(file, home);
    expect(change.deleted).toBe(false);
    expect(readText(file)).toBe("# Mine\n");
  });

  it("respects existing user content around the block", () => {
    const home = temp();
    const root = temp();
    const file = path.join(root, "AGENTS.md");
    writeFileSyncAll(file, "# Team rules\n\nbe kind\n");
    const change = installCodexIntegration(root, { home });
    expect(change.created).toBe(false);
    const content = readText(file);
    expect(content.startsWith("# Team rules\n\nbe kind\n")).toBe(true);
    expect(content).toContain("## GLM Worker Delegation");
    // Removal keeps the user content intact.
    const removed = removeManagedFile(file, home);
    expect(removed.deleted).toBeFalsy();
    expect(readText(file)).toBe("# Team rules\n\nbe kind\n");
  });

  it("dry-run computes the change without writing", () => {
    const home = temp();
    const root = temp();
    const change = installClaudeIntegration(root, { home, dryRun: true });
    expect(change.newContent.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
  });

  it("ownership records are home-scoped", () => {
    const home = temp();
    const other = temp();
    const file = path.join(temp(), "CLAUDE.md");
    recordCreatedFile(file, home);
    expect(isOwnedFile(file, home)).toBe(true);
    expect(isOwnedFile(file, other)).toBe(false);
    forgetFile(file, home);
    expect(isOwnedFile(file, home)).toBe(false);
  });
});

describe("CodexSkillInstaller (spec §27)", () => {
  it("detects nothing without ~/.codex and warns/skips via null", () => {
    const home = temp();
    const installer = new CodexSkillInstaller(home);
    expect(installer.detect()).toBeNull();
  });

  it("installs and removes SKILL.md under ~/.codex/skills", () => {
    const home = temp();
    writeFileSyncAll(path.join(home, ".codex", "config.toml"), "");
    const installer = new CodexSkillInstaller(home);
    expect(installer.detect()).toEqual({ skillsDir: path.join(home, ".codex", "skills") });

    const skill = glmDelegationSkill();
    installer.install(skill);
    expect(installer.isInstalled(skill.name)).toBe(true);
    const content = readText(path.join(home, ".codex", "skills", skill.name, "SKILL.md"));
    expect(content).toContain("name: glm-delegation");
    expect(content).toContain("## Delegation packet");

    installer.remove(skill.name);
    expect(installer.isInstalled(skill.name)).toBe(false);
  });
});
