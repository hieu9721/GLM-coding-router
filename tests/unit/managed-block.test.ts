import { describe, expect, it } from "vitest";
import {
  END_MARKER,
  START_MARKER,
  hasManagedBlock,
  removeManagedBlock,
  upsertManagedBlock,
  validateMarkers,
} from "../../src/project/managed-block.js";
import { CLAUDE_MANAGED_BLOCK } from "../../src/templates/claude-block.js";

const BLOCK = `${START_MARKER}\n\nmanaged body\n\n${END_MARKER}`;

describe("validateMarkers", () => {
  it("accepts content without markers", () => {
    expect(() => validateMarkers("# Hello\n", "CLAUDE.md")).not.toThrow();
  });

  it("accepts a well-formed pair", () => {
    expect(() => validateMarkers(`text\n${BLOCK}\n`, "CLAUDE.md")).not.toThrow();
  });

  it("rejects start marker without end marker (corrupt)", () => {
    expect(() => validateMarkers(`${START_MARKER}\nbody\n`, "CLAUDE.md")).toThrow(/start marker without end/);
  });

  it("rejects end marker without start marker (corrupt)", () => {
    expect(() => validateMarkers(`body\n${END_MARKER}\n`, "CLAUDE.md")).toThrow(/end marker without start/);
  });

  it("rejects duplicate start markers", () => {
    expect(() =>
      validateMarkers(`${START_MARKER}\n${START_MARKER}\n${END_MARKER}`, "CLAUDE.md"),
    ).toThrow(/multiple start/);
  });

  it("rejects end marker before start marker", () => {
    expect(() => validateMarkers(`${END_MARKER}\n${START_MARKER}`, "CLAUDE.md")).toThrow(/before start/);
  });
});

describe("upsertManagedBlock (spec §21, §48)", () => {
  it("creates content for an empty file", () => {
    const result = upsertManagedBlock("", BLOCK, "CLAUDE.md");
    expect(result).toBe(BLOCK + "\n");
  });

  it("appends to an existing file preserving user content (LF)", () => {
    const existing = "# Existing content\n\nSome notes.\n";
    const result = upsertManagedBlock(existing, BLOCK, "CLAUDE.md");
    expect(result.startsWith("# Existing content\n\nSome notes.\n")).toBe(true);
    expect(result.endsWith(`\n\n${BLOCK}\n`)).toBe(true);
    expect(result).toContain("# Existing content");
  });

  it("appends to a file without trailing newline without eating content", () => {
    const existing = "# No trailing newline";
    const result = upsertManagedBlock(existing, BLOCK, "CLAUDE.md");
    expect(result).toBe(`# No trailing newline\n\n${BLOCK}\n`);
  });

  it("replaces an existing block in place, never duplicating (idempotent)", () => {
    const existing = `# Header\n\n${BLOCK}\n\nUser footer\n`;
    const result = upsertManagedBlock(existing, BLOCK, "CLAUDE.md");
    expect(result).toBe(existing);
    expect(result.match(new RegExp(START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
  });

  it("updates a changed block while preserving surrounding content", () => {
    const oldBlock = `${START_MARKER}\n\nold body\n\n${END_MARKER}`;
    const existing = `prefix\n${oldBlock}\nsuffix\n`;
    const result = upsertManagedBlock(existing, BLOCK, "CLAUDE.md");
    expect(result).toBe(`prefix\n${BLOCK}\nsuffix\n`);
  });

  it("preserves CRLF line endings", () => {
    const crlfBlock = BLOCK.replace(/\n/g, "\r\n");
    const existing = "# Header\r\n\r\nnotes\r\n";
    const result = upsertManagedBlock(existing, BLOCK, "CLAUDE.md");
    expect(result).toBe(`# Header\r\n\r\nnotes\r\n\r\n${crlfBlock}\r\n`);
    expect(result).not.toMatch(/(?<!\r)\n/);
  });

  it("preserves UTF-8 content (Vietnamese)", () => {
    const existing = "# Tiêu đề dự án\n\nNội dung bảo toàn.\n";
    const result = upsertManagedBlock(existing, BLOCK, "CLAUDE.md");
    expect(result).toContain("# Tiêu đề dự án");
    expect(result).toContain("Nội dung bảo toàn.");
  });

  it("throws on corrupt markers and leaves content untouched (caller must not write)", () => {
    const corrupt = `${START_MARKER}\nbody without end\n`;
    expect(() => upsertManagedBlock(corrupt, BLOCK, "CLAUDE.md")).toThrow();
    expect(corrupt).toBe(`${START_MARKER}\nbody without end\n`);
  });

  it("works with the real CLAUDE template (spec §20)", () => {
    const result = upsertManagedBlock("x\n", CLAUDE_MANAGED_BLOCK, "CLAUDE.md");
    expect(result).toContain("## GLM Worker Delegation");
    expect(result).toContain('`glm-worker "<task>"`');
  });
});

describe("removeManagedBlock (spec §43, §48)", () => {
  it("returns empty string for a router-only file", () => {
    expect(removeManagedBlock(`${BLOCK}\n`, "CLAUDE.md")).toBe("");
  });

  it("removes the block and keeps user content", () => {
    const existing = `# Header\n\nbefore\n\n${BLOCK}\n\nafter footer\n`;
    const result = removeManagedBlock(existing, "CLAUDE.md");
    expect(result).toBe("# Header\n\nbefore\n\nafter footer\n");
    expect(hasManagedBlock(result)).toBe(false);
  });

  it("leaves files without a block untouched", () => {
    const existing = "# Just user content\n";
    expect(removeManagedBlock(existing, "CLAUDE.md")).toBe(existing);
  });

  it("handles CRLF files", () => {
    const crlfBlock = BLOCK.replace(/\n/g, "\r\n");
    const existing = `# H\r\n\r\n${crlfBlock}\r\n\r\nfooter\r\n`;
    const result = removeManagedBlock(existing, "CLAUDE.md");
    expect(result).toBe("# H\r\n\r\nfooter\r\n");
  });

  it("throws on a corrupt marker pair", () => {
    expect(() => removeManagedBlock(`${END_MARKER}\n`, "CLAUDE.md")).toThrow();
  });
});
