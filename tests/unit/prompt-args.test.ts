import { describe, expect, it } from "vitest";
import { resolvePrompt } from "../../src/core/prompt.js";
import { Errors, GlmRouterError } from "../../src/core/errors.js";
import { buildReviewArgs, REVIEW_TOOLS } from "../../src/bin/glm-review.js";
import { buildWorkerArgs, extractNoBashFlag, WORKER_TOOLS } from "../../src/bin/glm-worker.js";
import { defaultConfig } from "../../src/core/config.js";

describe("resolvePrompt (spec §15, §40: stdin → args → error)", () => {
  it("prefers stdin text over arguments", async () => {
    const prompt = await resolvePrompt(["from", "args"], () => Promise.resolve("TASK:\nfrom stdin"));
    expect(prompt).toBe("TASK:\nfrom stdin");
  });

  it("falls back to joined arguments when stdin is empty", async () => {
    const prompt = await resolvePrompt(["Fix login"], () => Promise.resolve(undefined));
    expect(prompt).toBe("Fix login");
  });

  it("falls back to arguments when stdin is whitespace only", async () => {
    const prompt = await resolvePrompt(["Fix login"], () => Promise.resolve("   \n"));
    expect(prompt).toBe("Fix login");
  });

  it("errors with PROMPT_REQUIRED when both are empty (exit 2)", async () => {
    try {
      await resolvePrompt([], () => Promise.resolve(undefined));
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GlmRouterError);
      expect((error as GlmRouterError).codeName).toBe("PROMPT_REQUIRED");
      expect((error as GlmRouterError).exitCode).toBe(2);
    }
  });

  it("supports multi-line task packets via stdin (spec §15)", async () => {
    const packet = "TASK:\nImplement refresh token validation.\n\nSCOPE:\ninternal/auth/";
    const prompt = await resolvePrompt([], () => Promise.resolve(packet));
    expect(prompt).toBe(packet);
  });
});

describe("claude argument construction (spec §16, §17)", () => {
  it("glm-worker uses -p, max-turns, acceptEdits, and the limited tool surface", () => {
    const config = defaultConfig();
    const args = buildWorkerArgs("Do work", config);
    expect(args.slice(0, 8)).toEqual([
      "-p",
      "Do work",
      "--max-turns",
      "20",
      "--permission-mode",
      "acceptEdits",
      "--tools",
      "Read,Glob,Grep,Edit,Write,Bash",
    ]);
    expect(args.join(" ")).not.toContain("--dangerously-skip-permissions");
    expect(args.join(" ")).not.toContain("bypassPermissions");
    expect(WORKER_TOOLS).toContain("Edit");
  });

  // specs/worker-bash-permissions.md — without --allowedTools every Bash call
  // comes back "This command requires approval" in headless -p mode.
  it("glm-worker pre-approves the configured Bash patterns", () => {
    const args = buildWorkerArgs("Do work", defaultConfig());
    const at = args.indexOf("--allowedTools");
    expect(at).toBeGreaterThan(-1);
    const patterns = args.slice(at + 1);
    expect(patterns).toContain("Bash(npm test)");
    expect(patterns).toContain("Bash(python3 *)");
    expect(patterns.every((p) => p.startsWith("Bash("))).toBe(true);
    // Validation commands only: no git writes, no rm, no network.
    const joined = patterns.join(" ");
    for (const forbidden of ["git commit", "git push", "rm ", "curl", "wget", "sudo"]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("glm-worker drops Bash entirely when the allowlist is empty", () => {
    const base = defaultConfig();
    const args = buildWorkerArgs("Do work", {
      ...base,
      worker: { ...base.worker, allowedBash: [] },
    });
    expect(args).not.toContain("--allowedTools");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Edit,Write");
  });

  it("--no-bash empties the allowlist for one invocation", () => {
    expect(extractNoBashFlag(["task", "--no-bash"])).toEqual({ rest: ["task"], noBash: true });
    expect(extractNoBashFlag(["task"])).toEqual({ rest: ["task"], noBash: false });
  });

  it("glm-review is read-only: Read,Glob,Grep only, and no inherited MCP tools", () => {
    const config = defaultConfig();
    const args = buildReviewArgs("Inspect", config);
    // --tools restricts only the built-in set, so --strict-mcp-config is part
    // of the read-only guarantee, not decoration (specs/review-mcp-isolation.md).
    expect(args).toEqual([
      "-p",
      "Inspect",
      "--max-turns",
      "15",
      "--tools",
      "Read,Glob,Grep",
      "--strict-mcp-config",
    ]);
    expect(REVIEW_TOOLS).not.toContain("Edit");
    expect(REVIEW_TOOLS).not.toContain("Write");
    expect(REVIEW_TOOLS).not.toContain("Bash");
  });

  it("takes max turns from config", () => {
    const config = defaultConfig();
    config.worker.maxTurns = 7;
    config.review.maxTurns = 3;
    expect(buildWorkerArgs("t", config)).toContain("7");
    expect(buildReviewArgs("t", config)).toContain("3");
  });
});

describe("error formatting (spec §36)", () => {
  it("renders ERROR [CODE] with an actionable hint and the right exit code", () => {
    const error = Errors.zaiKeyMissing();
    expect(error.codeName).toBe("ZAI_KEY_MISSING");
    expect(error.exitCode).toBe(10);
    expect(error.hint.join("\n")).toContain("glm-router key set");
  });

  it("maps every spec §35 code", () => {
    expect(Errors.claudeNotFound().exitCode).toBe(20);
    expect(Errors.codexNotFound().exitCode).toBe(21);
    expect(Errors.configInvalid("x").exitCode).toBe(11);
    expect(Errors.childAgentFailed("x").exitCode).toBe(40);
    expect(Errors.unsupportedPlatform("linux").exitCode).toBe(50);
    expect(Errors.managedFileWriteFailed("f", "x").exitCode).toBe(31);
  });
});
