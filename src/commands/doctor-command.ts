import { runDoctorChecks, doctorHasFailures, type CheckResult } from "./doctor.js";
import { emitJson, type GlobalOptions } from "./context.js";
import { logger } from "../core/logging.js";

const SYMBOL: Record<CheckResult["status"], string> = {
  ok: "✓",
  warn: "⚠",
  fail: "✗",
};

function renderText(results: readonly CheckResult[], networkResult?: string): string {
  const lines: string[] = ["GLM Coding Router Doctor", ""];
  let currentSection = "";
  for (const result of results) {
    if (result.section !== currentSection) {
      currentSection = result.section;
      lines.push(currentSection);
    }
    lines.push(`  ${SYMBOL[result.status]} ${result.name}`);
    if (result.detail) {
      lines.push(`      ${result.detail}`);
    }
    if (result.note) {
      lines.push(`      ${result.note}`);
    }
  }
  if (networkResult) {
    lines.push("Network");
    lines.push(`  ${networkResult === "reachable" ? "✓" : "⚠"} Z.ai endpoint ${networkResult}`);
  }
  const failures = doctorHasFailures(results);
  lines.push("");
  lines.push(`Status: ${failures ? "ISSUES DETECTED" : "HEALTHY"}`);
  return lines.join("\n");
}

/** Lightweight endpoint reachability probe (spec §42). Never consumes coding quota. */
export async function probeEndpoint(baseUrl: string): Promise<string> {
  try {
    const response = await fetch(baseUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    // Any HTTP response proves reachability; auth errors are expected without a key.
    return response.status < 500 ? "reachable" : `reachable with errors (HTTP ${response.status})`;
  } catch {
    return "not reachable";
  }
}

export async function doctorCommand(options: GlobalOptions & { network?: boolean }): Promise<number> {
  const report = runDoctorChecks();

  if (options.json) {
    emitJson({
      status: doctorHasFailures(report.results) ? "ISSUES" : "HEALTHY",
      checks: report.results,
      keySource: report.keySource,
    });
    return doctorHasFailures(report.results) ? 1 : 0;
  }

  const networkResult = options.network
    ? await probeEndpoint(report.config.provider.anthropicBaseUrl)
    : undefined;
  process.stdout.write(renderText(report.results, networkResult) + "\n");
  logger.debug(`anthropic base url: ${report.config.provider.anthropicBaseUrl}`);
  return doctorHasFailures(report.results) ? 1 : 0;
}
