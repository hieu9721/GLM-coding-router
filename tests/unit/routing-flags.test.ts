import { describe, expect, it } from "vitest";
import { extractRoutingFlags } from "../../src/core/routing-flags.js";

describe("extractRoutingFlags (specs/v2-architecture.md Phase E)", () => {
  it("leaves an argv without routing flags untouched", () => {
    const flags = extractRoutingFlags(["Implement the parser", "--max-turns", "20"]);

    expect(flags.rest).toEqual(["Implement the parser", "--max-turns", "20"]);
    expect(flags.model).toBeUndefined();
    expect(flags.force).toBe(false);
    expect(flags.refreshQuota).toBe(false);
  });

  it("accepts both --model spellings and keeps the prompt intact", () => {
    expect(extractRoutingFlags(["--model", "fast", "Do the thing"])).toMatchObject({
      rest: ["Do the thing"],
      model: "fast",
    });
    expect(extractRoutingFlags(["--model=main", "Do the thing"])).toMatchObject({
      rest: ["Do the thing"],
      model: "main",
    });
  });

  it("extracts --force and --refresh-quota from anywhere in argv", () => {
    const flags = extractRoutingFlags(["Fix", "--force", "the", "--refresh-quota", "bug"]);

    expect(flags.rest).toEqual(["Fix", "the", "bug"]);
    expect(flags.force).toBe(true);
    expect(flags.refreshQuota).toBe(true);
  });

  it("consumes repeats so a second flag can never reach the prompt", () => {
    // Whatever survives here becomes task text, not a flag — that is the
    // whole reason repeats are swallowed rather than passed through.
    const flags = extractRoutingFlags(["--model", "fast", "--model", "main", "Task", "--force", "--force"]);

    expect(flags.rest).toEqual(["Task"]);
    expect(flags.model).toBe("fast"); // first occurrence wins
    expect(flags.force).toBe(true);
  });

  it("rejects a model name instead of a slot, naming both valid values", () => {
    expect(() => extractRoutingFlags(["--model", "glm-5.3-flash", "Task"])).toThrowError(
      /--model expects "main" or "fast".*glm-5\.3-flash/s,
    );
    expect(() => extractRoutingFlags(["--model=gpt-4"])).toThrowError(/main.*fast/s);
  });

  it("rejects a trailing --model with no value", () => {
    expect(() => extractRoutingFlags(["Task", "--model"])).toThrowError(/--model expects/);
  });

  it("the rejection is INVALID_ARGS, exit code 2", () => {
    try {
      extractRoutingFlags(["--model", "nope"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toMatchObject({ codeName: "INVALID_ARGS", exitCode: 2 });
    }
  });
});
