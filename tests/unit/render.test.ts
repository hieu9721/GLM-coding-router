import { afterEach, describe, expect, it, vi } from "vitest";
import { createWriter, displayWidth, padEndDisplay, paint, truncate } from "../../src/tui/render.js";

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

  it("counts wide (CJK) characters as 2 columns, not 1 code unit (specs/terminal-ui-doctor.md §A)", () => {
    // "文件路径测试用例" is 8 wide chars = 16 columns.
    const wide = "文件路径测试用例";
    expect(displayWidth(wide)).toBe(16);
    const cut = truncate(wide, 10);
    expect(displayWidth(cut)).toBeLessThanOrEqual(10);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("does not cut a string whose display width already fits, even with wide characters", () => {
    const wide = "文件路径"; // 4 wide chars = 8 columns
    expect(truncate(wide, 8)).toBe(wide);
  });
});

describe("displayWidth (specs/terminal-ui-doctor.md §A)", () => {
  it("is the plain length for ASCII text", () => {
    expect(displayWidth("hello world")).toBe(11);
  });

  it("counts each CJK character as 2 columns", () => {
    expect(displayWidth("中文")).toBe(4);
  });

  it("counts common emoji as 2 columns", () => {
    expect(displayWidth("🚀")).toBe(2);
  });

  it("counts zero-width joiners/variation selectors/combining marks as 0", () => {
    expect(displayWidth("é")).toBe(1); // "é" as e + combining acute accent
    expect(displayWidth("﻿")).toBe(0); // BOM / zero-width no-break space
  });

  it("handles a mix of ASCII and wide characters", () => {
    expect(displayWidth("path: 路径/file.txt")).toBe("path: ".length + 4 + "/file.txt".length);
  });
});

describe("padEndDisplay", () => {
  it("pads ASCII text exactly like String.padEnd", () => {
    expect(padEndDisplay("abc", 6)).toBe("abc   ");
  });

  it("pads a wide-character string by fewer spaces than padEnd would (correct visual column)", () => {
    // "中文" is 2 code units but 4 display columns — target 6 columns needs 2 spaces, not 4.
    expect(padEndDisplay("中文", 6)).toBe("中文  ");
    expect(padEndDisplay("中文", 6).length).toBe(4); // 2 CJK chars + 2 spaces, in UTF-16 units
  });

  it("never truncates when already at/over the target width", () => {
    expect(padEndDisplay("中文中文", 4)).toBe("中文中文");
  });
});
