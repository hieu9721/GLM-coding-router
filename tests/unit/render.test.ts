import { afterEach, describe, expect, it, vi } from "vitest";
import { createWriter, paint, truncate } from "../../src/tui/render.js";

function ttyStream(): NodeJS.WriteStream {
  return { isTTY: true, columns: 80, write: () => true } as unknown as NodeJS.WriteStream;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createWriter color decision (specs/terminal-ui-doctor.md §A 'Terminal contracts')", () => {
  it("is on for a plain TTY with no NO_COLOR/TERM=dumb", () => {
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("TERM", "xterm-256color");
    expect(createWriter(ttyStream()).color).toBe(true);
  });

  it("is off for a non-TTY stream regardless of env", () => {
    const stream = { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream;
    expect(createWriter(stream).color).toBe(false);
  });

  it("is off when NO_COLOR is set, even on a TTY", () => {
    vi.stubEnv("NO_COLOR", "1");
    expect(createWriter(ttyStream()).color).toBe(false);
  });

  it("is off when TERM=dumb, even on a TTY", () => {
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("TERM", "dumb");
    expect(createWriter(ttyStream()).color).toBe(false);
  });

  it("an explicit opts.color overrides every environment signal", () => {
    vi.stubEnv("TERM", "dumb");
    expect(createWriter(ttyStream(), { color: true }).color).toBe(true);
    const nonTty = { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream;
    expect(createWriter(nonTty, { color: false }).color).toBe(false);
  });
});

describe("paint", () => {
  it("wraps text in escape codes only when the writer has color on", () => {
    const on = createWriter(ttyStream(), { color: true });
    const off = createWriter(ttyStream(), { color: false });
    expect(paint(on, "green", "x")).toContain("[32m");
    expect(paint(off, "green", "x")).toBe("x");
  });
});

describe("truncate", () => {
  it("leaves short text untouched", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("cuts long text and marks it with an ellipsis", () => {
    expect(truncate("a very long path indeed", 10)).toBe("a very lo…");
    expect(truncate("a very long path indeed", 10)).toHaveLength(10);
  });

  it("returns empty for a non-positive max", () => {
    expect(truncate("x", 0)).toBe("");
  });
});
