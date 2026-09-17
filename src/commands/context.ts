import { ExitCode, formatGlmError, GlmRouterError } from "../core/errors.js";
import { logger, type LogLevel } from "../core/logging.js";

export interface GlobalOptions {
  readonly json?: boolean;
  readonly quiet?: boolean;
  readonly verbose?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly yes?: boolean;
}

/** Configure the shared logger from global flags (spec §8, §37). */
export function applyGlobalOptions(options: GlobalOptions): void {
  const level: LogLevel = options.verbose ? "debug" : "info";
  logger.setLevel(level, options.quiet ?? false);
}

/** Uniform error reporting for command actions. */
export function reportError(error: unknown): number {
  if (error instanceof GlmRouterError) {
    process.stderr.write(formatGlmError(error) + "\n");
    return error.exitCode;
  }
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`ERROR [INTERNAL]\n\n${message}\n`);
  return ExitCode.GenericFailure;
}

export function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
