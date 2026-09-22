import { runDoctorChecks, doctorHasFailures, type CheckResult } from "./doctor.js";
import { emitJson, type GlobalOptions } from "./context.js";
import { logger } from "../core/logging.js";
import { Errors } from "../core/errors.js";
import { inspectZaiKey, type KeyComparison, type KeyInspection } from "../core/key-inspector.js";
import {
  authenticateZaiKey,
  authenticationCheckStatus,
  deriveDoctorVerdict,
  type AuthenticationResult,
  type DoctorStatus,
} from "./doctor-auth.js";
import { describeKeyStore, detectUserEnvStore, type UserEnvStore } from "../core/user-env.js";
import { createWriter, type Writer } from "../tui/render.js";
import { createCommandUi, type UiStatus } from "../tui/command-ui.js";
import { version } from "../core/version.js";

/** Lightweight endpoint reachability probe (spec §42). Never consumes coding quota. */
export async function probeEndpoint(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const response = await fetchImpl(baseUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    // Any HTTP response proves reachability; auth errors are expected without a key.
    return response.status < 500 ? "reachable" : `reachable with errors (HTTP ${response.status})`;
  } catch {
    return "not reachable";
  }
}

function shellUnsetLines(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return ["PowerShell:  Remove-Item Env:ZAI_API_KEY", "CMD:         set ZAI_API_KEY="];
  }
  return ["POSIX shell: unset ZAI_API_KEY"];
}

function describeComparisonRow(inspection: KeyInspection): { status: UiStatus; value: string } {
  switch (inspection.comparison) {
    case "match":
      return { status: "ok", value: "Matches the saved key" };
    case "different":
      return { status: "warn", value: "Different from the saved key" };
    case "unavailable":
      return { status: "warn", value: `Could not read ${describeKeyStore(inspection.store)} to compare` };
    case "not-comparable":
      if (inspection.store === "none") {
        return { status: "info", value: "No persistent store on this platform" };
      }
      if (inspection.effectiveSource === "process-env") {
        return { status: "info", value: "No saved key to compare against" };
      }
      if (inspection.effectiveSource === "user-store") {
        return { status: "info", value: "No process override" };
      }
      return { status: "info", value: "Not applicable" };
  }
}

/** Ordered, actionable "next step" lines. Empty when the verdict is HEALTHY. */
function buildNextSteps(input: {
  readonly authentication: AuthenticationResult;
  readonly comparison: KeyComparison;
  readonly store: UserEnvStore;
  readonly platform: NodeJS.Platform;
  readonly networkProbeFailed: boolean;
  readonly verdictStatus: DoctorStatus;
}): string[] {
  const { authentication, comparison, store, platform, networkProbeFailed, verdictStatus } = input;
  if (verdictStatus === "HEALTHY") {
    return [];
  }

  const lines: string[] = [];

  if (comparison === "different") {
    lines.push(
      "This terminal's key takes priority over the saved key (process environment wins).",
      "Restart the terminal's hosting app to refresh its environment,",
      "or if this is an intentional process override, update that override instead.",
      ...shellUnsetLines(platform),
    );
  } else if (comparison === "unavailable") {
    lines.push(`Could not read ${describeKeyStore(store)} to compare against the process key.`);
  }

  switch (authentication.reason) {
    case "missing-key":
      lines.push(
        "No ZAI_API_KEY was found.",
        platform === "win32" ? "Run: glm-router key set" : 'Run: glm-router key set, or export ZAI_API_KEY="<your-key>"',
      );
      break;
    case "http-401":
      lines.push("The selected key was rejected. To replace it: glm-router key set");
      break;
    case "http-403":
      lines.push("Access was denied for the selected key. Check the key's account permissions — not necessarily expiry.");
      break;
    case "rate-limited":
      lines.push("The Z.ai monitor endpoint is rate-limiting this key. Retry in a moment.");
      break;
    case "http-error":
    case "network-error":
    case "timeout":
      lines.push("Could not reach the Z.ai monitor endpoint. Check network/proxy connectivity and retry.");
      break;
    case "invalid-response":
    case "provider-error":
      lines.push("The Z.ai monitor endpoint returned an unexpected response — this is not proof the key is invalid.");
      break;
    case "offline":
      lines.push("Authentication was not checked (--offline). Run without --offline to verify the key online.");
      break;
    case "accepted":
      break;
  }

  if (networkProbeFailed) {
    lines.push("The configured Anthropic endpoint reachability probe did not succeed (separate from key authentication).");
  }

  if (lines.length > 0 && authentication.reason !== "offline") {
    lines.push("Then run: glm-router doctor");
  }

  return lines;
}

export interface DoctorCommandDeps {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Threaded into runDoctorChecks only; the credential inspector uses readUserEnvDiagnostic. */
  readonly readUserEnv?: (name: string) => string | undefined;
  readonly readUserEnvDiagnostic?: (name: string) => { readable: boolean; value: string | undefined };
  readonly fetchImpl?: typeof fetch;
  readonly store?: UserEnvStore;
  readonly platform?: NodeJS.Platform;
  readonly stdout?: NodeJS.WriteStream;
}

export async function doctorCommand(
  options: GlobalOptions & { network?: boolean; offline?: boolean },
  deps: DoctorCommandDeps = {},
): Promise<number> {
  if (options.offline && options.network) {
    throw Errors.invalidArgs("--offline and --network cannot be used together.", [
      "Use --offline for local-only checks, or --network for the extra reachability probe.",
    ]);
  }

  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const offline = options.offline ?? false;
  const platform = deps.platform ?? process.platform;
  const store = deps.store ?? detectUserEnvStore({ platform, env });

  const report = runDoctorChecks({ home: deps.home, env, readUserEnv: deps.readUserEnv, store });
  const inspection = inspectZaiKey({ env, readUserEnvDiagnostic: deps.readUserEnvDiagnostic, store });

  const [authentication, networkResult] = await Promise.all([
    authenticateZaiKey(inspection.effectiveKey, fetchImpl, offline),
    options.network ? probeEndpoint(report.config.provider.anthropicBaseUrl, fetchImpl) : Promise.resolve(undefined),
  ]);

  const localFailure = doctorHasFailures(report.results);
  const networkProbeFailed = networkResult !== undefined && networkResult !== "reachable";
  const verdict = deriveDoctorVerdict({
    localFailure,
    authentication,
    keyComparison: inspection.comparison,
    offline,
    networkProbeFailed,
  });

  if (options.json) {
    emitJson({
      status: verdict.status,
      checks: report.results,
      keySource: report.keySource,
      network: networkResult,
      authentication,
      keyComparison: inspection.comparison,
      keyMismatch: inspection.keyMismatch,
    });
    return verdict.exitCode;
  }

  const stream = deps.stdout ?? process.stdout;
  const writer: Writer = createWriter(stream);
  const ui = createCommandUi(writer, { quiet: options.quiet });
  writer.line(renderText(ui, report.results, inspection, authentication, networkResult, verdict, platform));
  logger.debug(`anthropic base url: ${report.config.provider.anthropicBaseUrl}`);
  return verdict.exitCode;
}

function renderText(
  ui: ReturnType<typeof createCommandUi>,
  results: readonly CheckResult[],
  inspection: KeyInspection,
  authentication: AuthenticationResult,
  networkResult: string | undefined,
  verdict: { status: DoctorStatus; exitCode: number },
  platform: NodeJS.Platform,
): string {
  const blocks: string[] = [];
  const header = ui.header(`GLM CODING ROUTER  v${version}  /  DOCTOR`, "Runtime and credential diagnostics");
  if (header) blocks.push(header);

  let currentSection = "";
  const localRows: string[] = [];
  for (const result of results) {
    if (result.section !== currentSection) {
      currentSection = result.section;
      localRows.push(ui.section(currentSection.toUpperCase()));
    }
    const status: UiStatus = result.status === "ok" ? "ok" : result.status === "warn" ? "warn" : "fail";
    localRows.push(ui.row(result.name, result.detail ?? "", status));
    if (result.note) localRows.push(ui.detail(result.note));
  }
  blocks.push(localRows.join("\n"));

  const credentialRows: string[] = [ui.section("CREDENTIALS")];
  credentialRows.push(
    ui.row("Selected source", inspection.effectiveSource === "process-env" ? "Process environment" : inspection.effectiveSource === "user-store" ? describeKeyStore(inspection.store) : "none", "info"),
  );
  const comparisonRow = describeComparisonRow(inspection);
  credentialRows.push(ui.row("Saved key comparison", comparisonRow.value, comparisonRow.status));
  credentialRows.push(
    ui.row("Monitor authentication", authentication.detail, authenticationCheckStatus(authentication.state)),
  );
  blocks.push(credentialRows.join("\n"));

  if (networkResult !== undefined) {
    const networkRows = [
      ui.section("NETWORK"),
      ui.row("Z.ai endpoint reachability", networkResult, networkResult === "reachable" ? "ok" : "warn"),
    ];
    blocks.push(networkRows.join("\n"));
  }

  const nextSteps = buildNextSteps({
    authentication,
    comparison: inspection.comparison,
    store: inspection.store,
    platform,
    networkProbeFailed: networkResult !== undefined && networkResult !== "reachable",
    verdictStatus: verdict.status,
  });
  if (nextSteps.length > 0) {
    const footer = ui.footer(nextSteps.join("\n"));
    if (footer) blocks.push([ui.section("NEXT STEP"), footer].join("\n"));
  }

  const resultLabel: Record<DoctorStatus, string> = {
    HEALTHY: "HEALTHY",
    ATTENTION: "ATTENTION",
    UNVERIFIED: "UNVERIFIED",
    ISSUES: "ISSUES DETECTED",
  };
  blocks.push(`RESULT  ${resultLabel[verdict.status]}`);

  return blocks.join("\n\n");
}
