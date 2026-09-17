import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { doctorHasFailures, runDoctorChecks } from "../../src/commands/doctor.js";
import { makeTempDir, removeTempDir, writeFileSyncAll } from "../helpers/tmp.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) removeTempDir(dir);
  dirs = [];
});

function temp(): string {
  const dir = makeTempDir("glm-doctor-test-");
  dirs.push(dir);
  return dir;
}

/** PATH fully replaced — isolates agent discovery from whatever is actually installed. */
function isolatedEnv(pathDirs: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    PATHEXT: process.env.PATHEXT,
    PATH: pathDirs.join(path.delimiter),
    ...extra,
  };
}

describe("runDoctorChecks (spec §9)", () => {
  it("reports Claude Code as fail and Codex as warn (not fail) when neither is on PATH", () => {
    const home = temp();
    const emptyPath = temp();
    const report = runDoctorChecks({ home, env: isolatedEnv([emptyPath]) });

    const claude = report.results.find((r) => r.section === "Agents" && r.name === "Claude Code");
    const codex = report.results.find((r) => r.section === "Agents" && r.name === "Codex");
    expect(claude?.status).toBe("fail");
    expect(codex?.status).toBe("warn");
    expect(codex?.note).toMatch(/Claude-only setups are supported/);
    // Codex being absent is a WARN (spec §34) and must not by itself flip doctor to failing —
    // Claude's own "fail" is what does that here.
    expect(doctorHasFailures(report.results)).toBe(true);
  });

  it("reports Claude Code as ok once it's found on an isolated PATH", () => {
    const home = temp();
    const dir = temp();
    writeFileSyncAll(path.join(dir, "claude.exe"), "");
    const report = runDoctorChecks({ home, env: isolatedEnv([dir]) });

    const claude = report.results.find((r) => r.section === "Agents" && r.name === "Claude Code");
    expect(claude?.status).toBe("ok");
    expect(claude?.detail).toBe(path.join(dir, "claude.exe"));
  });

  it("reports ZAI_API_KEY as fail when neither process env nor Windows User Env has it", () => {
    const home = temp();
    const emptyPath = temp();
    const report = runDoctorChecks({
      home,
      env: isolatedEnv([emptyPath]),
      readUserEnv: () => undefined,
    });

    const key = report.results.find((r) => r.section === "Z.ai" && r.name === "ZAI_API_KEY");
    expect(key?.status).toBe("fail");
    expect(report.keySource).toBeUndefined();
  });

  it("reports ZAI_API_KEY as ok, sourced from process env, when injected there", () => {
    const home = temp();
    const emptyPath = temp();
    const report = runDoctorChecks({
      home,
      env: isolatedEnv([emptyPath], { ZAI_API_KEY: "test-key" }),
      readUserEnv: () => undefined,
    });

    const key = report.results.find((r) => r.section === "Z.ai" && r.name === "ZAI_API_KEY");
    expect(key?.status).toBe("ok");
    expect(report.keySource).toBe("process-env");
  });

  it("falls back to config defaults when no config.json exists at the given home", () => {
    const home = temp();
    const emptyPath = temp();
    const report = runDoctorChecks({ home, env: isolatedEnv([emptyPath]) });

    expect(report.config.models.main).toBe("glm-5.3");
    expect(report.config.models.fast).toBe("glm-5.3-flash");
  });
});
