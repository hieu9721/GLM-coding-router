import { afterEach, describe, expect, it, vi } from "vitest";
import { landingCommand } from "../../src/commands/landing.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

describe("landingCommand (specs/terminal-ui-doctor.md §B.1)", () => {
  it("renders the offline landing page and exits 0", () => {
    const out = captureStdout();
    const code = landingCommand({});
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("GLM CODING ROUTER");
    expect(text).toContain("glm-router doctor");
    expect(text).toContain("glm-worker");
    expect(text).toContain("glm-router init");
  });

  it("--json with no command is an actionable argument error, not decorated help", () => {
    expect(() => landingCommand({ json: true })).toThrow(/requires a command that produces data/);
    try {
      landingCommand({ json: true });
    } catch (error) {
      expect((error as { exitCode?: number }).exitCode).toBe(2);
    }
  });

  it("quiet suppresses the header/footer but still names the commands", () => {
    const out = captureStdout();
    landingCommand({ quiet: true });
    const text = out.text();
    expect(text).not.toContain("+--");
    expect(text).toContain("glm-router doctor");
  });
});
