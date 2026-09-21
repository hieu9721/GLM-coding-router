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
  const color = opts?.color ?? (isTTY && !noColor);
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
 * Cut `text` to `max` characters, marking the cut with a single ellipsis
 * character so a truncated path stays visually distinguishable from a real one.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max - 1) + "…";
}
