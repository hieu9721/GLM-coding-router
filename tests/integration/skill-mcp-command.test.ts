import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { skillInstallCommand, skillRemoveCommand } from "../../src/commands/skill.js";
import { statusCommand } from "../../src/commands/status.js";
import { runDoctorChecks } from "../../src/commands/doctor.js";
import { ClaudeSkillInstaller, CodexSkillInstaller } from "../../src/integrations/skill.js";
import { GLM_DELEGATION_SKILL_NAME } from "../../src/templates/glm-delegation-skill.js";
import { mcpCommand, mcpServerScript, MCP_SERVER_NAME } from "../../src/commands/mcp.js";
import { defaultConfig } from "../../src/core/config.js";
import { makeTempDir, readText, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-skill-mcp-");
  dirs.push(dir);
  return dir;
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

function homeWith(agentHomes: string[]): string {
  const home = temp();
  for (const agent of agentHomes) {
    fs.mkdirSync(path.join(home, agent), { recursive: true });
  }
  return home;
}

describe("dual-target skill (specs/v1-architecture.md)", () => {
  it("installs into both ~/.claude/skills and ~/.codex/skills when both homes exist", () => {
    const home = homeWith([".claude", ".codex"]);
    const out = captureStdout();

    const code = skillInstallCommand({}, { home });

    expect(code).toBe(0);
    for (const dir of [".claude", ".codex"]) {
      const skill = path.join(home, dir, "skills", GLM_DELEGATION_SKILL_NAME, "SKILL.md");
      expect(fs.existsSync(skill), dir).toBe(true);
      expect(readText(skill).length).toBeGreaterThan(10);
    }
    expect(out.text()).toContain("Claude:");
    expect(out.text()).toContain("Codex:");
  });

  it("skips per agent when a home is missing; second install run is a no-op", () => {
    const home = homeWith([".claude"]); // no ~/.codex
    const out = captureStdout();

    skillInstallCommand({}, { home });

    expect(fs.existsSync(path.join(home, ".claude", "skills", GLM_DELEGATION_SKILL_NAME, "SKILL.md"))).toBe(true);
    expect(out.text()).toContain("Claude");
    expect(out.text()).toContain("skipping optional skill");

    const second = captureStdout();
    skillInstallCommand({}, { home });
    expect(second.text()).toContain("already installed");
  });

  it("remove cleans both agents; absent skill is a no-op", () => {
    const home = homeWith([".claude", ".codex"]);
    skillInstallCommand({}, { home });

    captureStdout(); // keep remove output out of the test log
    const code = skillRemoveCommand({}, { home });

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, ".claude", "skills", GLM_DELEGATION_SKILL_NAME))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex", "skills", GLM_DELEGATION_SKILL_NAME))).toBe(false);

    const again = captureStdout();
    skillRemoveCommand({}, { home });
    expect(again.text()).toContain("not installed");
  });

  it("status renders one skill row per agent; doctor checks both", () => {
    const home = homeWith([".claude", ".codex"]);
    skillInstallCommand({}, { home });

    const out = captureStdout();
    statusCommand({}, { home, env: {} as NodeJS.ProcessEnv, readUserEnv: () => undefined });
    // Presence, not exact geometry: the width/alignment contract itself is
    // guarded by command-ui.test.ts and status.test.ts.
    expect(out.text()).toMatch(/Claude skill\s+enabled/);
    expect(out.text()).toMatch(/Codex skill\s+enabled/);

    const report = runDoctorChecks({ home, env: {} as NodeJS.ProcessEnv, readUserEnv: () => undefined });
    const skillChecks = report.results.filter((result) => result.name === "Delegation skill");
    expect(skillChecks.map((check) => check.section).sort()).toEqual(["Claude", "Codex"]);
    expect(skillChecks.every((check) => check.status === "ok")).toBe(true);
  });

  it("ClaudeSkillInstaller and CodexSkillInstaller detect their own homes only", () => {
    const home = homeWith([".claude"]);
    expect(new ClaudeSkillInstaller(home).detect()).not.toBeNull();
    expect(new CodexSkillInstaller(home).detect()).toBeNull();
  });
});

describe("mcp command (specs/v1-architecture.md)", () => {
  function claudeHome(): string {
    const home = temp();
    writeFileSyncAll(
      path.join(home, ".glm-coding-router", "config.json"),
      JSON.stringify({ ...defaultConfig(), claudePath: process.execPath }),
    );
    return home;
  }

  it("info prints a valid JSON snippet and the claude mcp add command", async () => {
    const out = captureStdout();

    const code = await mcpCommand({}, "info");

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain(`claude mcp add -s user ${MCP_SERVER_NAME} --`);
    const snippetStart = text.indexOf("{");
    const snippetEnd = text.lastIndexOf("}");
    const snippet = JSON.parse(text.slice(snippetStart, snippetEnd + 1)) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = snippet.mcpServers[MCP_SERVER_NAME];
    expect(server.args[0]).toBe(mcpServerScript());
  });

  it("install runs claude mcp add with node + the server script; remove mirrors it", async () => {
    const calls: { bin: string; args: string[] }[] = [];
    const runClaude = async (bin: string, args: readonly string[]) => {
      calls.push({ bin, args: [...args] });
      return { code: 0, stdout: "added", stderr: "" };
    };
    const out = captureStdout();

    const code = await mcpCommand({}, "install", { home: claudeHome(), env: {} as NodeJS.ProcessEnv, runClaude });

    expect(code).toBe(0);
    expect(calls[0].args).toEqual(["mcp", "add", "-s", "user", MCP_SERVER_NAME, "--", process.execPath, mcpServerScript()]);
    expect(out.text()).toContain("registered");

    const removeOut = captureStdout();
    const removeCode = await mcpCommand({}, "remove", { home: claudeHome(), env: {} as NodeJS.ProcessEnv, runClaude });
    expect(removeCode).toBe(0);
    expect(calls[1].args).toEqual(["mcp", "remove", "-s", "user", MCP_SERVER_NAME]);
    expect(removeOut.text()).toContain("removed");
  });

  it("install failure surfaces the claude error; missing claude → ERROR [20]", async () => {
    const failing = async () => ({ code: 2, stdout: "", stderr: "already exists" });
    await expect(
      mcpCommand({}, "install", { home: claudeHome(), env: {} as NodeJS.ProcessEnv, runClaude: failing }),
    ).rejects.toMatchObject({ codeName: "CHILD_AGENT_FAILED", message: expect.stringContaining("already exists") });

    const noClaude = temp(); // no config file → no override, and empty env has no claude
    await expect(
      mcpCommand({}, "install", { home: noClaude, env: {} as NodeJS.ProcessEnv }),
    ).rejects.toMatchObject({ codeName: "CLAUDE_NOT_FOUND", exitCode: 20 });
  });
});
