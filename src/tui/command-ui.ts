/**
 * Shared presentation layer for the management screens — `doctor`, `status`,
 * `usage`, and the root landing page (specs/terminal-ui-doctor.md §A). This
 * module never fetches data, reads credentials, or makes routing decisions;
 * it only turns already-computed values into aligned, width-aware text.
 *
 * All ANSI stays in render.ts (`paint`); this file composes plain strings
 * and colors them through that one choke point.
 */
import { paint, truncate, type Writer } from "./render.js";

export type UiStatus = "ok" | "warn" | "fail" | "info";

const STATUS_TAG: Record<UiStatus, string> = {
  ok: "[OK]",
  warn: "[WARN]",
  fail: "[FAIL]",
  info: "[INFO]",
};

const STATUS_STYLE: Record<UiStatus, "green" | "yellow" | "red" | "cyan"> = {
  ok: "green",
  warn: "yellow",
  fail: "red",
  info: "cyan",
};

/** Widest tag ("[WARN]"/"[FAIL]"/"[INFO]") plus one separating space. */
const TAG_COLUMN = 7;
const BASE_INDENT = "  ";
const LABEL_COLUMN = 24;
const MIN_BOX_WIDTH = 44;
const MAX_BOX_WIDTH = 78;
const BAR_SLOTS = 20;

export interface CommandUi {
  /** Compact ASCII header box (or plain lines when the terminal is too narrow). "" when quiet. */
  header(title: string, subtitle?: string): string;
  /** A group title. Always emitted — it is structure, not decoration. */
  section(title: string): string;
  /** An aligned label/value row, with an [OK]/[WARN]/[FAIL]/[INFO] tag when `status` is given. */
  row(label: string, value: string, status?: UiStatus): string;
  /** An indented continuation line (or block) under the preceding row/section. */
  detail(text: string): string;
  /** Verdict + next-step block. "" when quiet — this is where "unsolicited tips" live. */
  footer(text: string): string;
  /** ASCII "percent consumed" bar; undefined renders an explicit unknown bar. */
  bar(percent: number | undefined): string;
}

function effectiveWidth(writer: Writer): number {
  return Number.isFinite(writer.columns) && writer.columns > 0 ? Math.floor(writer.columns) : 80;
}

/** Strip control characters from text that did not originate in this module (spec §A). */
function sanitize(text: string, allowNewline: boolean): string {
  const pattern = allowNewline ? /[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g : /[\x00-\x1F\x7F]/g;
  return text.replace(pattern, "");
}

function border(width: number): string {
  return `+${"-".repeat(Math.max(width - 2, 0))}+`;
}

function boxLine(text: string, width: number): string {
  const inner = Math.max(width - 4, 0);
  return `| ${truncate(text, inner).padEnd(inner)} |`;
}

/** Wrap `text` to `width`-wide lines without breaking a word mid-way when avoidable. */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

export function createCommandUi(writer: Writer, options: { quiet?: boolean } = {}): CommandUi {
  const quiet = options.quiet ?? false;

  return {
    header(title, subtitle) {
      if (quiet) return "";
      const width = effectiveWidth(writer);
      const cleanTitle = sanitize(title, false);
      const cleanSubtitle = subtitle !== undefined ? sanitize(subtitle, false) : undefined;

      if (width < MIN_BOX_WIDTH) {
        const lines = [paint(writer, "cyan", truncate(cleanTitle, width))];
        if (cleanSubtitle) lines.push(paint(writer, "dim", truncate(cleanSubtitle, width)));
        return lines.join("\n");
      }

      const boxWidth = Math.min(width, MAX_BOX_WIDTH);
      const lines = [border(boxWidth), boxLine(cleanTitle, boxWidth)];
      if (cleanSubtitle) lines.push(boxLine(cleanSubtitle, boxWidth));
      lines.push(border(boxWidth));
      return lines.join("\n");
    },

    section(title) {
      return paint(writer, "bold", sanitize(title, false));
    },

    row(label, value, status) {
      const width = effectiveWidth(writer);
      const cleanLabel = sanitize(label, false);
      const cleanValue = sanitize(value, false);

      const tagField = status !== undefined ? STATUS_TAG[status].padEnd(TAG_COLUMN) : "";
      const labelField = cleanLabel.padEnd(LABEL_COLUMN);
      const plainPrefix = `${BASE_INDENT}${tagField}${labelField}`;
      const singleLine = `${plainPrefix}${cleanValue}`;

      const coloredPrefix = (): string => {
        if (status === undefined) return plainPrefix;
        const tag = STATUS_TAG[status];
        return `${BASE_INDENT}${paint(writer, STATUS_STYLE[status], tag)}${tagField.slice(tag.length)}${labelField}`;
      };

      if (cleanValue.length === 0 || singleLine.replace(/\s+$/, "").length <= width) {
        return `${coloredPrefix()}${cleanValue}`.replace(/\s+$/, "");
      }

      // Stack: tag + label on one line, value wrapped and indented beneath.
      const tagLine =
        status !== undefined
          ? `${BASE_INDENT}${paint(writer, STATUS_STYLE[status], STATUS_TAG[status])} ${cleanLabel}`
          : `${BASE_INDENT}${cleanLabel}`;
      const valueIndent = `${BASE_INDENT}${" ".repeat(TAG_COLUMN)}`;
      const valueWidth = Math.max(width - valueIndent.length, 8);
      const valueLines = wrap(cleanValue, valueWidth).map((line) => `${valueIndent}${line}`);
      return [tagLine, ...valueLines].join("\n");
    },

    detail(text) {
      const width = effectiveWidth(writer);
      const indent = `${BASE_INDENT}${" ".repeat(TAG_COLUMN - 2)}`;
      const availableWidth = Math.max(width - indent.length, 8);
      const cleanText = sanitize(text, true);
      const lines: string[] = [];
      for (const paragraph of cleanText.split("\n")) {
        if (paragraph.length === 0) {
          lines.push("");
          continue;
        }
        for (const line of wrap(paragraph, availableWidth)) {
          lines.push(`${indent}${line}`);
        }
      }
      return lines.join("\n");
    },

    footer(text) {
      if (quiet) return "";
      const cleanText = sanitize(text, true);
      return cleanText
        .split("\n")
        .map((line) => (line.length === 0 ? "" : `${BASE_INDENT}${line}`))
        .join("\n");
    },

    bar(percent) {
      if (percent === undefined || !Number.isFinite(percent)) {
        return `[${"-".repeat(BAR_SLOTS)}] unknown`;
      }
      const clamped = Math.min(100, Math.max(0, percent));
      const filled = Math.round((clamped / 100) * BAR_SLOTS);
      const bar = `[${"#".repeat(filled)}${"-".repeat(BAR_SLOTS - filled)}]`;
      const style = clamped >= 90 ? "red" : clamped >= 70 ? "yellow" : "green";
      return `${paint(writer, style, bar)} ${Math.round(clamped)}% used`;
    },
  };
}
