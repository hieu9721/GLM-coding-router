import { describe, expect, it } from "vitest";
import { createWriter, displayWidth, type Writer } from "../../src/tui/render.js";
import { createCommandUi } from "../../src/tui/command-ui.js";

/** In-memory writer with a fixed width/color/TTY, for deterministic geometry tests. */
function fakeWriter(opts: { columns?: number; color?: boolean; isTTY?: boolean } = {}): Writer & { text: () => string } {
  const chunks: string[] = [];
  const stream = {
    isTTY: opts.isTTY ?? false,
    columns: opts.columns,
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const writer = createWriter(stream, { color: opts.color });
  return { ...writer, text: () => chunks.join("") };
}

function visibleWidth(line: string): number {
  return line.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function visibleWidthWide(line: string): number {
  return displayWidth(line.replace(/\u001b\[[0-9;]*m/g, ""));
}

describe("createCommandUi (specs/terminal-ui-doctor.md §A)", () => {
  it("header draws an ASCII box at 80 columns and both lines fit", () => {
    const writer = fakeWriter({ columns: 80 });
    const ui = createCommandUi(writer);
    const header = ui.header("GLM CODING ROUTER  vX.Y.Z", "Coding Plan workers");
    for (const line of header.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
    expect(header).toContain("+");
    expect(header).toContain("GLM CODING ROUTER");
  });

  it("header drops the box below the minimum width but keeps the text", () => {
    const writer = fakeWriter({ columns: 24 });
    const ui = createCommandUi(writer);
    const header = ui.header("GLM CODING ROUTER", "sub");
    expect(header).not.toContain("+");
    for (const line of header.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(24);
    }
  });

  it("no visible line is ever wider than the writer's columns, at 40 and 120", () => {
    for (const columns of [40, 120]) {
      const writer = fakeWriter({ columns });
      const ui = createCommandUi(writer);
      const block = [
        ui.header("GLM CODING ROUTER  vX.Y.Z  /  DOCTOR", "Runtime and credential diagnostics"),
        ui.row("Monitor authentication", "Request rejected (HTTP 401) — a very long detail that keeps going and going", "fail"),
        ui.detail("A very long continuation line that must wrap instead of overflowing the terminal width here"),
      ].join("\n");
      for (const line of block.split("\n")) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("row aligns label/value columns with the correct [TAG] prefix", () => {
    const writer = fakeWriter({ columns: 80 });
    const ui = createCommandUi(writer);
    expect(ui.row("Key presence", "Configured", "ok")).toContain("[OK]");
    expect(ui.row("Codex", "Optional; not installed", "warn")).toContain("[WARN]");
    expect(ui.row("Monitor authentication", "Rejected", "fail")).toContain("[FAIL]");
    expect(ui.row("Selected source", "Process environment", "info")).toContain("[INFO]");
  });

  it("row without a status has no bracket tag", () => {
    const writer = fakeWriter({ columns: 80 });
    const ui = createCommandUi(writer);
    const row = ui.row("Runs", "3");
    expect(row).not.toMatch(/\[(OK|WARN|FAIL|INFO)\]/);
    expect(row).toContain("Runs");
    expect(row).toContain("3");
  });

  it("never exceeds width with CJK/emoji content that has spaces to wrap at (labels, values, header, detail)", () => {
    for (const columns of [40, 80]) {
      const writer = fakeWriter({ columns });
      const ui = createCommandUi(writer);
      const block = [
        ui.header("GLM CODING ROUTER — 诊断报告 🚀", "路径诊断 credential 检查 diagnostics"),
        ui.row("路径", "已配置 configured 状态 🚀", "ok"),
        ui.row("狀態", "已配置 🚀🚀🚀", "info"),
        ui.detail("这是 一段 很长 的 说明 文字 用来 测试 自动 换行 是否 按 显示 宽度 而 不是 字符数 来 计算 这个 结果"),
      ].join("\n");
      for (const line of block.split("\n")) {
        const visible = line.replace(/\u001b\[[0-9;]*m/g, "");
        expect(visibleWidthWide(visible)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("measures a CJK path's real (wider) display width — it may still overflow when unbroken, same as a long ASCII path", () => {
    const writer = fakeWriter({ columns: 40 });
    const ui = createCommandUi(writer);
    const cjkPath = "C:\\用户\\示例\\路径\\claude.exe";
    const row = ui.row("路径", cjkPath, "ok");
    // Content is preserved verbatim (never cut mid-path), matching the
    // existing ASCII "never truncates a long path" contract.
    expect(row).toContain(cjkPath);
    expect(row).not.toContain("…");
    // But its real width is correctly measured as double a naive .length count.
    expect(displayWidth(cjkPath)).toBeGreaterThan(cjkPath.length);
  });

  it("never truncates a long path — it wraps to an indented continuation instead", () => {
    const writer = fakeWriter({ columns: 60 });
    const ui = createCommandUi(writer);
    const longPath = "C:\\Users\\example\\AppData\\Local\\really\\long\\nested\\path\\to\\claude.exe";
    const row = ui.row("Claude Code", longPath, "ok");
    expect(row).toContain(longPath);
    expect(row).not.toContain("…");
  });

  it("color codes appear only when the writer reports color, never in piped output", () => {
    const colorWriter = fakeWriter({ columns: 80, color: true });
    const plainWriter = fakeWriter({ columns: 80, color: false });
    expect(createCommandUi(colorWriter).row("x", "y", "ok")).toContain("\u001b[");
    expect(createCommandUi(plainWriter).row("x", "y", "ok")).not.toContain("\u001b[");
  });

  it("quiet suppresses header and footer but not rows", () => {
    const writer = fakeWriter({ columns: 80 });
    const quiet = createCommandUi(writer, { quiet: true });
    expect(quiet.header("title")).toBe("");
    expect(quiet.footer("tip")).toBe("");
    expect(quiet.row("x", "y", "ok")).toContain("x");
  });

  it("sanitizes control characters from external text before styling", () => {
    const writer = fakeWriter({ columns: 80 });
    const ui = createCommandUi(writer);
    const row = ui.row("label\u0007", "value\u001b[31mFAKE", "ok");
    expect(row).not.toContain("\u0007");
    // The literal escape sequence embedded in untrusted input must not survive as raw bytes.
    expect(row.includes("\u001b[31mFAKE")).toBe(false);
  });

  it("bar renders unknown explicitly for undefined percent, never a zero-filled bar implying no usage", () => {
    const writer = fakeWriter({ columns: 80 });
    const ui = createCommandUi(writer);
    expect(ui.bar(undefined)).toContain("unknown");
    expect(ui.bar(undefined)).not.toMatch(/\d+% used/);
  });

  it("bar clamps out-of-range percentages into 0-100", () => {
    const writer = fakeWriter({ columns: 80 });
    const ui = createCommandUi(writer);
    expect(ui.bar(150)).toContain("100% used");
    expect(ui.bar(-10)).toContain("0% used");
  });

  it.each([
    [10, "green"],
    [75, "yellow"],
    [95, "red"],
  ] as const)("bar at %i%% uses the correct color threshold", (percent, expected) => {
    const writer = fakeWriter({ columns: 80, color: true });
    const ui = createCommandUi(writer);
    const codes: Record<string, string> = { green: "\u001b[32m", yellow: "\u001b[33m", red: "\u001b[31m" };
    expect(ui.bar(percent)).toContain(codes[expected]);
  });
});
