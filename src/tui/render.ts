/**
 * Writer abstraction over an injectable output stream (specs/v2-architecture.md,
 * Phase C, decision D1: dependency-free TUI).
 *
 * This is the ONLY file in the codebase that contains ANSI escape sequences, so
 * swapping the rendering backend later (e.g. Ink) is a contained change. It also
 * keeps contract C1 testable: a caller injects the stream it wants to assert on,
 * and this module never touches `process.stdout` or `process.stderr` itself.
 */

/** Everything a renderer needs from an output channel. */
export interface Writer {
  write(text: string): void;
  /** write + "\\n"; with no argument, just a blank line. */
  line(text?: string): void;
  readonly isTTY: boolean;
  readonly color: boolean;
  readonly columns: number;
}

/**
 * The escape sequences the TUI needs. Kept as data, not methods on Writer, so
 * a renderer can compose them (cursorUp + clearLine per redrawn line) in one
 * write call where the platform batches better.
 */
export const ansi = {
  /** Move the cursor up `n` lines; empty string for n <= 0 (a no-op move). */
  cursorUp(n: number): string {
    return n > 0 ? `\u001b[${n}A` : "";
  },
  /** Erase the whole current line (cursor column is untouched). */
  clearLine: "\u001b[2K",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
};

export type Style = "dim" | "bold" | "green" | "red" | "yellow" | "cyan";

const STYLE_CODES: Record<Style, string> = {
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
};

const RESET = "\u001b[0m";

/**
 * Wrap `text` in the escape pair for `style`, or return it unchanged when the
 * writer has color off — piped output must stay byte-clean for machines.
 */
export function paint(writer: Writer, style: Style, text: string): string {
  return writer.color ? `${STYLE_CODES[style]}${text}${RESET}` : text;
}

/**
 * Build a Writer over any writable stream. `isTTY`/`columns` are read off the
 * stream when present (only real terminals have them); `color` defaults to
 * `isTTY && !NO_COLOR` because honoring NO_COLOR is part of the platform
 * contract, and an explicit `opts.color` overrides both.
 */
export function createWriter(
  stream: NodeJS.WriteStream | NodeJS.WritableStream,
  opts?: { color?: boolean },
): Writer {
  // NodeJS.WritableStream does not declare terminal-only members, so narrow
  // through a structural shape instead of trusting the declared type.
  const terminal = stream as { isTTY?: boolean; columns?: number };
  const isTTY = terminal.isTTY === true;
  const noColor = (process.env.NO_COLOR ?? "").length > 0;
  const dumbTerm = process.env.TERM === "dumb";
  const color = opts?.color ?? (isTTY && !noColor && !dumbTerm);
  return {
    write(text: string): void {
      stream.write(text);
    },
    line(text?: string): void {
      stream.write((text ?? "") + "\n");
    },
    isTTY,
    color,
    columns: terminal.columns ?? 80,
  };
}

/**
 * Terminal display width of one Unicode code point: 0 for combining marks,
 * variation selectors and control characters, 2 for East Asian Wide/Fullwidth
 * ranges and common emoji, 1 otherwise. A simplified, dependency-free
 * approximation of Markus Kuhn's wcwidth (specs/terminal-ui-doctor.md §A
 * "Width uses display cells, not ANSI string length") — good enough for
 * layout purposes without pulling in a wcwidth/string-width package, which
 * would break the TUI's dependency-free design (specs/v2-architecture.md D1).
 */
function codePointWidth(cp: number): 0 | 1 | 2 {
  if (
    cp === 0 ||
    (cp >= 0x0001 && cp <= 0x001f) ||
    (cp >= 0x007f && cp <= 0x009f) ||
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space/joiners, LTR/RTL marks
    cp === 0xfeff || // zero-width no-break space / BOM
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols
    (cp >= 0x1f3fb && cp <= 0x1f3ff) // emoji skin-tone modifiers
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, CJK punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK compat, enclosed CJK
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji: symbols/pictographs, emoticons
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // transport/map symbols
    (cp >= 0x1f900 && cp <= 0x1f9ff) || // supplemental symbols/pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK unified ideographs, supplementary planes
  ) {
    return 2;
  }
  return 1;
}

/** Total terminal display width of `text`, iterating by code point (not UTF-16 unit). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

/** Right-pad `text` with spaces until its DISPLAY width reaches `target` (never cuts). */
export function padEndDisplay(text: string, target: number): string {
  const pad = target - displayWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/**
 * Cut `text` to `max` display columns, marking the cut with a single ellipsis
 * character so a truncated path stays visually distinguishable from a real one.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (displayWidth(text) <= max) {
    return text;
  }
  const budget = max - 1; // reserve one column for the ellipsis
  let width = 0;
  let result = "";
  for (const char of text) {
    const w = codePointWidth(char.codePointAt(0) ?? 0);
    if (width + w > budget) break;
    result += char;
    width += w;
  }
  return result + "…";
}
