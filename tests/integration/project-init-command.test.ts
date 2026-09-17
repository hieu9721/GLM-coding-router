import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { projectInitCommand } from "../../src/commands/project-init.js";
import { END_MARKER, START_MARKER } from "../../src/project/managed-block.js";
import { makeTempDir, readText, removeTempDir } from "../helpers/tmp.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = makeTempDir("glm-project-init-cmd-");
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

/** Temp home with no config file — loadConfig falls back to defaults (all integrations on). */
function freshHome(): string {
  return temp();
}

describe("projectInitCommand rendering (spec §45 dry-run preview)", () => {
  it("dry-run on a fresh project says would update and writes nothing", () => {
    const home = freshHome();
    const root = temp();
    const out = captureStdout();

    const code = projectInitCommand({ dryRun: true }, { root, home });

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("would update");
    expect(text).toContain(`--- ${path.join(root, "CLAUDE.md")} (new file)`);
    expect(text).toContain(`+ ${START_MARKER}`);
    expect(text).toContain(`+ ${END_MARKER}`);
    expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(false);
  });

  it("dry-run on an already-installed project reports up to date without a diff", () => {
    const home = freshHome();
    const root = temp();
    projectInitCommand({}, { root, home }); // real run installs the blocks

    const claudeMd = path.join(root, "CLAUDE.md");
    const agentsMd = path.join(root, "AGENTS.md");
    const before = [readText(claudeMd), readText(agentsMd)];
    const out = captureStdout();

    const code = projectInitCommand({ dryRun: true }, { root, home });

    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("already up to date");
    expect(text).not.toContain("would update");
    expect(text).not.toContain("--- ");
    expect(readText(claudeMd)).toBe(before[0]);
    expect(readText(agentsMd)).toBe(before[1]);
  });

  it("second real run is a no-op and reports already up to date", () => {
    const home = freshHome();
    const root = temp();
    projectInitCommand({}, { root, home });
    const claudeMd = path.join(root, "CLAUDE.md");
    const before = readText(claudeMd);
    const out = captureStdout();

    const code = projectInitCommand({}, { root, home });

    expect(code).toBe(0);
    expect(out.text()).toContain("already up to date");
    expect(readText(claudeMd)).toBe(before);
  });
});
