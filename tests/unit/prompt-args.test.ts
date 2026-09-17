import { describe, expect, it } from "vitest";
import { resolvePrompt } from "../../src/core/prompt.js";
import { Errors, GlmRouterError } from "../../src/core/errors.js";
import { buildReviewArgs, REVIEW_TOOLS } from "../../src/bin/glm-review.js";
import { buildWorkerArgs, WORKER_TOOLS } from "../../src/bin/glm-worker.js";
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
    expect(args).toEqual([
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
    expect(WORKER_TOOLS).toContain("Edit");
  });

  it("glm-review is read-only: Read,Glob,Grep only", () => {
    const config = defaultConfig();
    const args = buildReviewArgs("Inspect", config);
    expect(args).toEqual(["-p", "Inspect", "--max-turns", "15", "--tools", "Read,Glob,Grep"]);
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
