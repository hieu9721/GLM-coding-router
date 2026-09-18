import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import prompts from "prompts";
import { version } from "../core/version.js";
import { WORKER_TOOLS } from "../bin/glm-worker.js";
import { loadConfig } from "../core/config.js";
import { locateClaude } from "../core/claude.js";
import { createGlmEnv } from "../core/env.js";
import { Errors } from "../core/errors.js";
import { configDir } from "../core/paths.js";
import { spawnAgentCapture, type CapturedResult, type SpawnAgentOptions } from "../core/process.js";
import { resolveZaiApiKey } from "../core/zai-key.js";
import { BENCHMARK_TASKS, benchmarkTaskById, type BenchmarkTask } from "../templates/benchmark-tasks.js";
import { emitJson, type GlobalOptions } from "./context.js";

export interface BenchmarkOptions extends GlobalOptions {
  /** Selected task ids; empty means "all built-in tasks". */
  readonly task?: string[];
  readonly stack?: string;
  readonly maxTurns?: number;
  readonly repeat?: number;
}

export interface BenchmarkDeps {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readUserEnv?: (name: string) => string | undefined;
  /** Interactive confirmation; injected in tests. */
  readonly confirm?: () => Promise<boolean>;
  /** Whether the session can prompt; defaults to process.stdin.isTTY. */
  readonly interactive?: boolean;
  readonly spawn?: (binPath: string, options: SpawnAgentOptions) => Promise<CapturedResult>;
  /** Wall clock for durations and the report timestamp. */
  readonly now?: () => number;
  /** Fresh run directory per task; defaults to fs.mkdtempSync. */
  readonly mkdtemp?: () => string;
}

/** The subset of Claude Code's -p --output-format json result we read. */
interface ClaudeResult {
  readonly subtype?: string;
  readonly isError?: boolean;
  readonly numTurns?: number;
  readonly durationMs?: number;
  readonly usage?: { input_tokens?: number; output_tokens?: number };
}

export interface TaskRunMetrics {
  readonly task: string;
  readonly run: number;
  readonly durationMs: number;
  readonly childDurationMs: number | null;
  readonly workerExit: number;
  readonly glmCalls: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly subtype: string | null;
  readonly testsPass: boolean;
  readonly testsOutput: string;
  readonly success: boolean;
  readonly interventionNeeded: boolean;
  readonly resultParsed: boolean;
}

const KNOWN_STACKS = ["claude", "codex"] as const;

/**
 * glm-router benchmark (spec §54 v0.4, specs/benchmark.md): run built-in
 * coding tasks through the Claude+GLM worker path and report §54 metrics.
 * Failed tasks are measurements, not CLI errors — exits 0 once the suite ran.
 */
export async function benchmarkCommand(
  options: BenchmarkOptions,
  deps: BenchmarkDeps = {},
): Promise<number> {
  const stack = options.stack ?? "claude";
  if (stack === "codex") {
    throw Errors.invalidArgs(
      "The codex stack is not supported yet: headless Codex orchestration cannot be driven reliably today.",
      ["v0.4 ships the harness + claude stack; codex slots in later without redesign."],
    );
  }
  if (!KNOWN_STACKS.includes(stack as (typeof KNOWN_STACKS)[number])) {
    throw Errors.invalidArgs(`Unknown stack "${stack}".`, [`Known stacks: ${KNOWN_STACKS.join(", ")}`]);
  }

  const ids = options.task && options.task.length > 0 ? options.task : BENCHMARK_TASKS.map((t) => t.id);
  const unknown = ids.filter((id) => !benchmarkTaskById(id));
  if (unknown.length > 0) {
    throw Errors.invalidArgs(
      `Unknown task id(s): ${unknown.join(", ")}.`,
      [`Available tasks: ${BENCHMARK_TASKS.map((t) => t.id).join(", ")}`],
    );
  }
  const tasks = ids.map((id) => benchmarkTaskById(id)!);

  const repeat = options.repeat ?? 1;
  const maxTurns = options.maxTurns;
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw Errors.invalidArgs(`--repeat expects a positive integer, got "${repeat}".`);
  }
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
    throw Errors.invalidArgs(`--max-turns expects a positive integer, got "${maxTurns}".`);
  }

  if (options.dryRun) {
    if (options.json) {
      emitJson({ stack, tasks: ids, repeat, maxTurns: maxTurns ?? "(config default)", dryRun: true });
    } else {
      const lines = [
        `would run stack   ${stack}`,
        `would run tasks   ${ids.join(", ")}`,
        `would repeat      ${repeat}x`,
        `would use maxTurns ${maxTurns ?? "(config default)"}`,
      ];
      process.stdout.write(lines.join("\n") + "\n");
    }
    return 0;
  }

  const interactive = deps.interactive ?? process.stdin.isTTY === true;
  if (!options.yes) {
    if (!interactive) {
      throw Errors.invalidArgs(
        `benchmark makes real GLM API calls; confirm with --yes when running non-interactively.`,
        [`  glm-router benchmark --yes`],
      );
    }
    const confirm = deps.confirm ?? defaultConfirm;
    const ok = await confirm();
    if (!ok) {
      process.stdout.write("Cancelled.\n");
      return 1;
    }
  }

  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const config = loadConfig(home);
  const resolved = resolveZaiApiKey({ env, readUserEnv: deps.readUserEnv });
  if (!resolved) {
    throw Errors.zaiKeyMissing();
  }
  const claudePath = locateClaude(config, env);

  const turns = maxTurns ?? config.worker.maxTurns;
  const now = deps.now ?? Date.now;
  const mkdtemp = deps.mkdtemp ?? (() => fs.mkdtempSync(path.join(os.tmpdir(), "glm-benchmark-")));
  const spawn = deps.spawn ?? spawnAgentCapture;

  const startedAt = new Date(now()).toISOString();
  const metrics: TaskRunMetrics[] = [];
  for (const task of tasks) {
    for (let run = 1; run <= repeat; run++) {
      metrics.push(await runTask(task, run, { turns, claudePath, config, key: resolved.key, env, now, mkdtemp, spawn }));
    }
  }

  const report = {
    version,
    stack,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    maxTurns: turns,
    repeat,
    tasks: metrics,
  };
  const savedPath = saveReport(report, home);
  if (!options.quiet && !options.json) {
    process.stdout.write(`report saved to ${savedPath}\n`);
  }
  if (options.json) {
    emitJson({ ...report, savedPath });
  } else {
    renderTable(metrics, options);
  }
  return 0;
}

interface RunContext {
  readonly turns: number;
  readonly claudePath: string;
  readonly config: ReturnType<typeof loadConfig>;
  readonly key: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly mkdtemp: () => string;
  readonly spawn: (binPath: string, options: SpawnAgentOptions) => Promise<CapturedResult>;
}

async function runTask(task: BenchmarkTask, run: number, ctx: RunContext): Promise<TaskRunMetrics> {
  const dir = ctx.mkdtemp();
  try {
    for (const [relative, content] of Object.entries(task.files)) {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    }

    const args = [
      "-p",
      task.prompt,
      "--max-turns",
      String(ctx.turns),
      "--permission-mode",
      "acceptEdits",
      "--tools",
      WORKER_TOOLS,
      "--output-format",
      "json",
    ];
    const childEnv = createGlmEnv(ctx.config, ctx.key, ctx.env);
    const started = ctx.now();
    let captured: CapturedResult;
    try {
      captured = await ctx.spawn(ctx.claudePath, { args, cwd: dir, env: childEnv, interactive: false });
    } catch (error) {
      throw Errors.childAgentFailed(error instanceof Error ? error.message : String(error));
    }
    const durationMs = ctx.now() - started;

    const parsed = parseClaudeResult(captured.stdout);
    const validation = await runValidation(task.validate, dir);

    const selfCompleted = captured.code === 0 && parsed?.isError !== true && !isErrorSubtype(parsed?.subtype);
    const success = selfCompleted && validation.pass;
    return {
      task: task.id,
      run,
      durationMs,
      childDurationMs: parsed?.durationMs ?? null,
      workerExit: captured.code,
      glmCalls: parsed?.numTurns ?? null,
      inputTokens: parsed?.usage?.input_tokens ?? null,
      outputTokens: parsed?.usage?.output_tokens ?? null,
      subtype: parsed?.subtype ?? null,
      testsPass: validation.pass,
      testsOutput: validation.output,
      success,
      interventionNeeded: !selfCompleted,
      resultParsed: parsed !== null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Parse the child's `--output-format json` result document (last JSON line wins). */
export function parseClaudeResult(stdout: string): ClaudeResult | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      if (typeof parsed === "object" && parsed !== null) {
        return {
          subtype: typeof parsed.subtype === "string" ? parsed.subtype : undefined,
          isError: typeof parsed.is_error === "boolean" ? parsed.is_error : undefined,
          numTurns: typeof parsed.num_turns === "number" ? parsed.num_turns : undefined,
          durationMs: typeof parsed.duration_ms === "number" ? parsed.duration_ms : undefined,
          usage:
            typeof parsed.usage === "object" && parsed.usage !== null
              ? {
                  input_tokens: numberOrUndefined((parsed.usage as Record<string, unknown>).input_tokens),
                  output_tokens: numberOrUndefined((parsed.usage as Record<string, unknown>).output_tokens),
                }
              : undefined,
        };
      }
    } catch {
      // Not JSON — keep walking backwards.
    }
  }
  return null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isErrorSubtype(subtype?: string): boolean {
  return subtype !== undefined && subtype.startsWith("error");
}

async function runValidation(argv: readonly string[], cwd: string): Promise<{ pass: boolean; output: string }> {
  const [bin, ...rest] = argv;
  return new Promise((resolve) => {
    execFile(
      bin,
      rest,
      { cwd, windowsHide: true, encoding: "utf8", timeout: 30_000 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        resolve({ pass: !error, output: output.length > 0 ? output.slice(-400) : "(no output)" });
      },
    );
  });
}

function saveReport(report: unknown, home: string): string {
  const dir = path.join(configDir(home), "benchmarks");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `benchmark-${stamp}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return file;
}

function renderTable(metrics: readonly TaskRunMetrics[], options: BenchmarkOptions): void {
  if (options.quiet) return;
  const header = ["task", "run", "duration", "GLM calls", "retries", "tokens i/o", "tests", "success", "intervention"];
  const rows = metrics.map((m) => [
    m.task,
    String(m.run),
    formatMs(m.durationMs),
    m.glmCalls === null ? "-" : String(m.glmCalls),
    "-", // retry count: not exposed by Claude Code (specs/benchmark.md)
    m.inputTokens === null || m.outputTokens === null ? "-" : `${m.inputTokens}/${m.outputTokens}`,
    m.testsPass ? "PASS" : "FAIL",
    m.success ? "yes" : "no",
    m.interventionNeeded ? "needed" : "none",
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
  process.stdout.write([line(header), ...rows.map(line)].join("\n") + "\n");
  for (const m of metrics.filter((m) => !m.testsPass)) {
    process.stdout.write(`\n${m.task} (run ${m.run}) validation output:\n${m.testsOutput}\n`);
  }
}

function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 100) / 10}s`;
}

async function defaultConfirm(): Promise<boolean> {
  const response = await prompts({
    type: "confirm",
    name: "ok",
    message: "Benchmark will make real GLM API calls. Continue?",
    initial: false,
  });
  return response.ok === true;
}

