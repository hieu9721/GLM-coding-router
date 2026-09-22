import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Errors } from "../core/errors.js";
import { configDir } from "../core/paths.js";
import { version } from "../core/version.js";
import { resolveZaiApiKey } from "../core/zai-key.js";
import { describeWindow, fetchZaiQuota } from "../core/zai-quota.js";
import type { ZaiQuotaData } from "../core/zai-quota.js";
import { emitJson, type GlobalOptions } from "./context.js";
import { createCommandUi } from "../tui/command-ui.js";
import { createWriter } from "../tui/render.js";

export interface UsageDeps {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readUserEnv?: (name: string) => string | undefined;
  readonly fetchImpl?: typeof fetch;
}

interface LocalUsage {
  readonly runs: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly lastFinishedAt: string | null;
}

/** Aggregate saved benchmark reports (specs/benchmark.md) into one local summary. */
export function aggregateLocalUsage(home: string): LocalUsage {
  const dir = path.join(configDir(home), "benchmarks");
  let runs = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let lastFinishedAt: string | null = null;
  if (!fs.existsSync(dir)) {
    return { runs, tokensIn, tokensOut, lastFinishedAt };
  }
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const report = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as {
        finishedAt?: string;
        tasks?: { inputTokens?: number | null; outputTokens?: number | null }[];
      };
      for (const run of report.tasks ?? []) {
        runs += 1;
        tokensIn += run.inputTokens ?? 0;
        tokensOut += run.outputTokens ?? 0;
      }
      if (typeof report.finishedAt === "string" && (!lastFinishedAt || report.finishedAt > lastFinishedAt)) {
        lastFinishedAt = report.finishedAt;
      }
    } catch {
      // Malformed report files are skipped — usage must never crash on bad data.
    }
  }
  return { runs, tokensIn, tokensOut, lastFinishedAt };
}

/**
 * glm-router usage (spec §54 v0.5, specs/usage.md): provider usage snapshots
 * where APIs allow reliable retrieval. Z.ai quota via the monitor endpoint;
 * Claude/Codex have no headless usage surface and say so; local totals come
 * from saved benchmark reports.
 */
export async function usageCommand(options: GlobalOptions, deps: UsageDeps = {}): Promise<number> {
  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const resolved = resolveZaiApiKey({ env, readUserEnv: deps.readUserEnv });
  if (!resolved) {
    throw Errors.zaiKeyMissing();
  }

  let quota: ZaiQuotaData | undefined;
  let quotaError: string | undefined;
  try {
    quota = await fetchZaiQuota(resolved.key, fetchImpl);
  } catch (error) {
    quotaError = error instanceof Error ? error.message : String(error);
  }

  const local = aggregateLocalUsage(home);
  const limits = quota?.limits ?? [];
  const json = {
    version,
    zai: quotaError
      ? { ok: false, error: quotaError }
      : {
          ok: true,
          level: quota?.level ?? null,
          limits: limits.map((limit) => ({
            window: describeWindow(limit),
            consumed: limit.currentValue ?? null,
            total: limit.usage ?? null,
            remaining: limit.remaining ?? null,
            percentage: limit.percentage ?? null,
            resetsAt: typeof limit.nextResetTime === "number" ? new Date(limit.nextResetTime).toISOString() : null,
          })),
        },
    local,
    claude: "not available — Claude Code exposes no headless usage API",
    codex: "not available — Codex exposes no plan-usage API",
  };

  if (options.json) {
    emitJson(json);
    return quotaError ? 1 : 0;
  }

  const ui = createCommandUi(createWriter(process.stdout));
  const lines: string[] = [`GLM Coding Router v${version} — usage snapshot`, ""];
  if (quotaError) {
    lines.push(`Z.ai Coding Plan`);
    lines.push(`  ✗ ${quotaError}`);
  } else {
    lines.push(`Z.ai Coding Plan${quota?.level ? ` (level: ${quota.level})` : ""}`);
    if (limits.length === 0) {
      lines.push("  (no quota windows reported)");
    }
    for (const limit of limits) {
      const consumed = limit.currentValue ?? "?";
      const total = limit.usage ?? "?";
      // Never treat a missing consumed/total as zero quota — only a finite
      // ratio with total > 0 may be turned into a percentage (spec §B.5).
      const percentNumeric: number | undefined =
        typeof limit.percentage === "number"
          ? limit.percentage
          : typeof limit.currentValue === "number" && typeof limit.usage === "number" && limit.usage > 0
            ? Math.round((limit.currentValue / limit.usage) * 100)
            : undefined;
      const percentage = percentNumeric ?? "?";
      const resets =
        typeof limit.nextResetTime === "number" ? ` — resets ${new Date(limit.nextResetTime).toISOString()}` : "";
      lines.push(`  ${describeWindow(limit).padEnd(15)} ${consumed} / ${total} credits (${percentage}%)${resets}`);
      const remaining = typeof limit.remaining === "number" ? `${limit.remaining} remaining` : "remaining unknown";
      lines.push(`    ${ui.bar(percentNumeric)} · ${remaining}`);
    }
  }
  lines.push("");
  lines.push("Local (benchmark reports)");
  if (local.runs === 0) {
    lines.push("  (none yet — run glm-router benchmark)");
  } else {
    lines.push(
      `  runs ${local.runs} · tokens ${local.tokensIn} in / ${local.tokensOut} out · last ${local.lastFinishedAt}`,
    );
  }
  lines.push("");
  lines.push(`Claude quota   ${json.claude}`);
  lines.push(`Codex usage    ${json.codex}`);
  process.stdout.write(lines.join("\n") + "\n");
  return quotaError ? 1 : 0;
}
