import path from "node:path";
import { logger } from "../core/logging.js";
import type { EventBus } from "../events/bus.js";
import type { RunCompleted, RunStarted, WorkerEvent } from "../events/types.js";
import { ansi, createWriter, paint, truncate } from "./render.js";
import type { Writer } from "./render.js";

/** The three progress renderers of doc §7. `off` lets callers express "nothing". */
export type ProgressMode = "rich" | "nested" | "off";

/**
 * Decide the mode from flags / env / config / TTY-ness. The order is
 * contractual: an orchestrator's `--quiet` or a CI environment must be able to
 * force silence even when config asks for rich, while an explicit env override
 * still beats config so `GLM_ROUTER_PROGRESS=nested glm-worker …` works on a
 * machine whose config says otherwise. `auto` (the config default) picks rich
 * for humans at a terminal and nested for everything piped.
 */
export function resolveProgressMode(input: {
  flagOff?: boolean;
  quiet?: boolean;
  configMode?: "auto" | "rich" | "nested" | "off";
  env?: NodeJS.ProcessEnv;
  isTTY: boolean;
}): ProgressMode {
  const env = input.env ?? {};
  if (input.flagOff || input.quiet || env.CI === "true" || env.GLM_ROUTER_PROGRESS === "off") {
    return "off";
  }
  const override = env.GLM_ROUTER_PROGRESS;
  if (override === "rich" || override === "nested") {
    return override;
  }
  if (env.GLM_ROUTER_NESTED === "1") {
    return "nested";
  }
  const configured = input.configMode;
  if (configured === "rich" || configured === "nested" || configured === "off") {
    return configured;
  }
  return input.isTTY ? "rich" : "nested";
}

/** What `attachProgress` installs: an event handler plus teardown. */
interface EventRenderer {
  handle(event: WorkerEvent): void;
  close(): void;
}

/**
 * Subscribe a progress renderer to the bus. The stream is a parameter, never
 * `process.stdout`, because that channel belongs to the worker's final answer
 * (contracts C1/C2) — production callers pass `process.stderr`, tests pass a
 * memory stream. `detach()` unsubscribes and restores the cursor.
 */
export function attachProgress(
  bus: EventBus,
  opts: {
    mode: ProgressMode;
    stream: NodeJS.WriteStream | NodeJS.WritableStream;
    color?: boolean;
    /** Directory basename for the rich header; derived from `RunStarted.cwd` when absent. */
    project?: string;
  },
): { detach(): void } {
  if (opts.mode === "off") {
    // Rendering nothing still needs a uniform handle so callers can detach blindly.
    return { detach(): void {} };
  }
  // Nested lines are parsed by orchestrators, so that mode defaults to plain
  // text unless the caller explicitly opts into color; rich keeps the writer's
  // own TTY/NO_COLOR default.
  const color = opts.color ?? (opts.mode === "nested" ? false : undefined);
  const writer = createWriter(opts.stream, { color });
  const renderer: EventRenderer =
    opts.mode === "nested"
      ? new NestedRenderer(writer, bus.runId)
      : new RichRenderer(writer, opts.project);
  const unsubscribe = bus.subscribe((event) => {
    // The bus already catches subscriber exceptions; the renderer guards itself
    // too so a half-broken state machine degrades instead of compounding.
    try {
      renderer.handle(event);
    } catch (error) {
      logger.debug(`progress renderer threw on ${event.type}: ${errorMessage(error)}`);
    }
  });
  return {
    detach(): void {
      unsubscribe();
      renderer.close();
    },
  };
}

/** Last 4 characters of the run id, uppercased — short enough to say aloud. */
function shortRunId(runId: string): string {
  return runId.slice(-4).toUpperCase();
}

/** Duration in seconds with one decimal, the resolution that is readable and honest. */
function formatSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * The one-word verb for a nested turn line. Validators are recognized via the
 * `ValidationStarted` that the adapter emits immediately before the matching
 * `ToolStarted`, so no tool-input inspection is needed here (C3).
 */
function nestedVerb(tool: string, isValidation: boolean): string {
  if (tool === "Read" || tool === "Grep" || tool === "Glob") {
    return "exploring";
  }
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    return "editing";
  }
  if (tool === "Bash") {
    return isValidation ? "running tests" : "running";
  }
  return `using ${tool}`;
}

/**
 * Nested mode: one stable `[GLM] …` line per significant event and no cursor
 * control, so an orchestrator can `readline` stderr without speaking ANSI.
 * These lines are a machine interface — change them only for cause.
 */
class NestedRenderer implements EventRenderer {
  private readonly writer: Writer;
  private readonly short: string;
  /** Turn whose first tool has already been announced; 0 = none. */
  private announcedTurn = 0;
  /** Turn of a `ValidationStarted` awaiting its `ToolStarted`. */
  private validationTurn: number | null = null;
  private finished = false;

  public constructor(writer: Writer, runId: string) {
    this.writer = writer;
    this.short = shortRunId(runId);
  }

  public handle(event: WorkerEvent): void {
    if (this.finished) {
      return;
    }
    switch (event.type) {
      case "RunStarted":
        this.writer.line(
          `[GLM] ${paint(this.writer, "cyan", "●")} #${this.short} started • ${event.model}`,
        );
        break;
      case "ValidationStarted":
        // Consumed by the ToolStarted that follows it in the same turn.
        this.validationTurn = event.turn;
        break;
      case "ToolStarted": {
        if (event.turn === this.announcedTurn) {
          break; // later tools of a turn print nothing
        }
        this.announcedTurn = event.turn;
        const isValidation = this.validationTurn === event.turn;
        if (isValidation) {
          this.validationTurn = null;
        }
        this.writer.line(
          `[GLM] turn ${event.turn} • ${nestedVerb(event.tool, isValidation)} ${event.summary}`,
        );
        break;
      }
      case "ValidationCompleted":
        this.writer.line(
          `[GLM] ${paint(this.writer, event.ok ? "green" : "red", event.ok ? "✓" : "✗")} tests ` +
            `${event.ok ? "passed" : "failed"}`,
        );
        break;
      case "ToolDenied":
        this.writer.line(
          `[GLM] ${paint(this.writer, "yellow", "⚠")} denied: ${event.tool} — ${event.reason}`,
        );
        break;
      case "ApiRetry":
        this.writer.line(`[GLM] ${paint(this.writer, "yellow", "⚠")} retry: ${event.reason}`);
        break;
      case "RunCompleted":
        this.writer.line(
          `[GLM] ${paint(this.writer, "green", "✓")} #${this.short} • ` +
            `${formatSeconds(event.durationMs)} • ${event.turns} turns • ${event.filesChanged} files`,
        );
        this.finished = true;
        break;
      case "RunFailed":
        this.writer.line(`[GLM] ${paint(this.writer, "red", "✗")} #${this.short} • ${event.reason}`);
        this.finished = true;
        break;
      case "RunCancelled":
        this.writer.line(`[GLM] ${paint(this.writer, "red", "✗")} #${this.short} • cancelled`);
        this.finished = true;
        break;
      default:
        break; // TurnStarted, Heartbeat, AgentInitialized, … — deliberately silent
    }
  }

  public close(): void {
    // No cursor was ever hidden in nested mode.
  }
}

/** Width of the rich header's label column ("Project" + 2 spaces, doc §7). */
const LABEL_WIDTH = 9;
/** Width of the rich tool column ("Write" + separator, doc §7). */
const TOOL_WIDTH = 5;
/** Width of the footer label column ("Duration" + 3 spaces, doc §7). */
const FOOTER_LABEL_WIDTH = 11;

const TITLE_BY_KIND: Record<RunStarted["kind"], string> = {
  worker: "GLM Worker",
  review: "GLM Review",
  delegate: "GLM Delegate",
};

/**
 * Rich mode: the doc §7 box header plus a per-turn tool tree. On a TTY the
 * current turn block is redrawn in place (cursor-up + erase per line); on a
 * non-TTY stream it appends, one entry behind, so the `└─` connector of the
 * last-known entry is never written wrong — piped output must stay readable
 * with zero escape codes, not a pile of them.
 */
class RichRenderer implements EventRenderer {
  private readonly writer: Writer;
  private readonly projectName?: string;
  private short = "";
  private currentTurn = 0;
  /** Plain content lines of the current turn block, connectors excluded. */
  private readonly entries: string[] = [];
  /** TTY: lines of the current block currently on screen (the redraw budget). */
  private drawn = 0;
  /** non-TTY: entries of the current block already written for good. */
  private flushed = 0;
  private finished = false;
  private cursorHidden = false;

  public constructor(writer: Writer, project?: string) {
    this.writer = writer;
    this.projectName = project;
  }

  public handle(event: WorkerEvent): void {
    if (this.finished) {
      return;
    }
    switch (event.type) {
      case "RunStarted":
        this.writeHeader(event);
        break;
      case "TurnStarted":
        this.beginTurn(event.turn);
        break;
      case "ToolStarted":
        // Defensive: a replayed stream without TurnStarted still groups by turn.
        if (event.turn !== this.currentTurn) {
          this.beginTurn(event.turn);
        }
        this.addEntry(`${event.tool.padEnd(TOOL_WIDTH)} ${this.summaryFit(event.summary)}`);
        break;
      case "ToolDenied":
        this.addEntry(
          `${paint(this.writer, "yellow", "⚠")} denied: ${event.tool} — ${this.summaryFit(event.reason)}`,
        );
        break;
      case "ApiRetry":
        this.addEntry(`${paint(this.writer, "yellow", "⚠")} retry: ${this.summaryFit(event.reason)}`);
        break;
      case "ValidationCompleted":
        this.addEntry(
          `${paint(this.writer, event.ok ? "green" : "red", event.ok ? "✓" : "✗")} tests ` +
            `${event.ok ? "passed" : "failed"}`,
        );
        break;
      case "RunCompleted":
        this.writeSuccessFooter(event);
        break;
      case "RunFailed":
        this.writeFailureClose(`✗ Failed — ${event.reason}`);
        break;
      case "RunCancelled":
        this.writeFailureClose("✗ Cancelled");
        break;
      default:
        break; // Heartbeat feeds the registry, not this tree
    }
  }

  public close(): void {
    this.restoreCursor();
  }

  private beginTurn(turn: number): void {
    this.finalizeBlock();
    this.currentTurn = turn;
    this.entries.length = 0;
    this.drawn = 0;
    this.flushed = 0;
    this.writer.line(`${paint(this.writer, "cyan", "◉")} Turn ${turn}`);
  }

  private addEntry(content: string): void {
    this.entries.push(content);
    this.refresh();
  }

  /** Bring the on-screen representation of the current block up to date. */
  private refresh(): void {
    if (this.writer.isTTY) {
      for (let i = 0; i < this.drawn; i++) {
        this.writer.write(ansi.cursorUp(1) + ansi.clearLine);
      }
      this.drawn = 0;
      for (const line of this.blockLines()) {
        this.writer.write(`${line}\n`);
        this.drawn++;
      }
      return;
    }
    // Append-only: hold the newest entry back until it is provably not the
    // last one, because written bytes cannot be taken back.
    while (this.entries.length - this.flushed >= 2) {
      this.writer.line(`  ├─ ${this.entries[this.flushed]}`);
      this.flushed++;
    }
  }

  /** Freeze the current block: previous turns are history and never redrawn. */
  private finalizeBlock(): void {
    if (!this.writer.isTTY && this.entries.length > this.flushed) {
      this.writer.line(`  └─ ${this.entries[this.entries.length - 1]}`);
      this.flushed = this.entries.length;
    }
  }

  private blockLines(): string[] {
    return this.entries.map((content, index) =>
      index === this.entries.length - 1 ? `  └─ ${content}` : `  ├─ ${content}`,
    );
  }

  private writeHeader(event: RunStarted): void {
    this.short = shortRunId(event.runId);
    if (this.writer.isTTY) {
      this.writer.write(ansi.hideCursor);
      this.cursorHidden = true;
    }
    const project = this.projectName ?? (path.basename(event.cwd) || event.cwd);
    const rows = [
      `${"Run".padEnd(LABEL_WIDTH)}#${this.short}`,
      `${"Model".padEnd(LABEL_WIDTH)}${event.model}`,
      `${"Project".padEnd(LABEL_WIDTH)}${project}`,
    ];
    const prefix = `─ ${TITLE_BY_KIND[event.kind]} `;
    const inner = Math.max(...rows.map((row) => row.length), prefix.length);
    this.writer.line(`╭${prefix}${"─".repeat(inner + 2 - prefix.length)}╮`);
    for (const row of rows) {
      this.writer.line(`│ ${row.padEnd(inner)} │`);
    }
    this.writer.line(`╰${"─".repeat(inner + 2)}╯`);
    this.writer.line();
  }

  private writeSuccessFooter(event: RunCompleted): void {
    this.finalizeBlock();
    this.writer.line();
    this.writer.line(`${paint(this.writer, "green", "✓")} Completed`);
    this.writer.line();
    this.writer.line(`${"Duration".padEnd(FOOTER_LABEL_WIDTH)}${formatSeconds(event.durationMs)}`);
    this.writer.line(`${"Turns".padEnd(FOOTER_LABEL_WIDTH)}${event.turns}`);
    this.writer.line(`${"Files".padEnd(FOOTER_LABEL_WIDTH)}${event.filesChanged}`);
    this.finish();
  }

  private writeFailureClose(text: string): void {
    this.finalizeBlock();
    this.writer.line();
    this.writer.line(paint(this.writer, "red", text));
    this.finish();
  }

  private finish(): void {
    this.finished = true;
    this.restoreCursor();
  }

  private restoreCursor(): void {
    if (this.cursorHidden) {
      this.writer.write(ansi.showCursor);
      this.cursorHidden = false;
    }
  }

  /** Cap a summary to the terminal width so one long path cannot wrap the tree. */
  private summaryFit(text: string): string {
    return truncate(text, Math.max(20, this.writer.columns - (TOOL_WIDTH + 7)));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
