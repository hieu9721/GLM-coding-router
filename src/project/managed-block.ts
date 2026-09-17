import { Errors } from "../core/errors.js";

export const START_MARKER = "<!-- glm-coding-router:start -->";
export const END_MARKER = "<!-- glm-coding-router:end -->";

export class ManagedBlockError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ManagedBlockError";
  }
}

/** Detect the file's dominant EOL; default LF (spec §48). */
function detectEol(content: string): "\r\n" | "\n" {
  const firstCr = content.indexOf("\r");
  if (firstCr === -1) return "\n";
  const firstLf = content.indexOf("\n");
  if (firstLf === -1) return "\n";
  return firstCr < firstLf - 1 ? "\n" : "\r\n";
}

function convertEol(text: string, eol: "\r\n" | "\n"): string {
  return eol === "\n" ? text.replace(/\r\n/g, "\n") : text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

/**
 * Validate marker pairing (spec §48): on a malformed pair the caller must
 * not modify the file and must surface an actionable error.
 */
export function validateMarkers(content: string, fileName: string): void {
  const starts = countOccurrences(content, START_MARKER);
  const ends = countOccurrences(content, END_MARKER);
  if (starts === 0 && ends === 0) return;
  if (starts > 1) {
    throw Errors.managedBlockCorrupt(fileName, "multiple start markers");
  }
  if (ends > 1) {
    throw Errors.managedBlockCorrupt(fileName, "multiple end markers");
  }
  if (starts === 1 && ends === 0) {
    throw Errors.managedBlockCorrupt(fileName, "start marker without end marker");
  }
  if (starts === 0 && ends === 1) {
    throw Errors.managedBlockCorrupt(fileName, "end marker without start marker");
  }
  if (content.indexOf(START_MARKER) > content.indexOf(END_MARKER)) {
    throw Errors.managedBlockCorrupt(fileName, "end marker appears before start marker");
  }
}

export function hasManagedBlock(content: string): boolean {
  return content.includes(START_MARKER) || content.includes(END_MARKER);
}

/**
 * Insert or replace the managed block (spec §21):
 * - absent  → append with a blank-line separator
 * - present → replace in place, preserving everything outside the markers
 * Idempotent: never duplicates, preserves the file's EOL style and
 * trailing-newline state.
 */
export function upsertManagedBlock(content: string, block: string, fileName: string): string {
  validateMarkers(content, fileName);
  const eol = detectEol(content);
  const blockText = convertEol(block.trim(), eol);

  if (content.includes(START_MARKER)) {
    const startIdx = content.indexOf(START_MARKER);
    const endIdx = content.indexOf(END_MARKER) + END_MARKER.length;
    const prefix = content.slice(0, startIdx);
    const suffix = content.slice(endIdx);
    return prefix + blockText + suffix;
  }

  if (content.trim().length === 0) {
    return blockText + eol;
  }

  const base = content.replace(/(?:\r?\n)+$/, "");
  return base + eol + eol + blockText + eol;
}

/**
 * Remove the managed block, preserving all user content (spec §43).
 * A file that contained only the block becomes empty (""), letting callers
 * decide whether to delete a router-created file.
 */
export function removeManagedBlock(content: string, fileName: string): string {
  validateMarkers(content, fileName);
  if (!content.includes(START_MARKER)) {
    return content;
  }
  const eol = detectEol(content);
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER) + END_MARKER.length;
  const prefix = content.slice(0, startIdx).replace(/(?:\r?\n)+$/, "");
  const suffix = content.slice(endIdx).replace(/^(?:\r?\n)+/, "");

  if (prefix.length === 0 && suffix.length === 0) return "";
  if (prefix.length === 0) return suffix;
  if (suffix.length === 0) return prefix + eol;
  return prefix + eol + eol + suffix;
}
