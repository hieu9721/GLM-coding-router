export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Replace every occurrence of a known secret with `[REDACTED]` (spec §37).
 * Empty/missing values are ignored; any real secret value is redacted.
 */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      output = output.split(secret).join("[REDACTED]");
    }
  }
  return output;
}

/** Minimal leveled logger honoring --quiet / --verbose. Writes to stderr so stdout stays parseable. */
export class Logger {
  private level: LogLevel;
  private quiet: boolean;

  public constructor(level: LogLevel = "info", quiet = false) {
    this.level = level;
    this.quiet = quiet;
  }

  public setLevel(level: LogLevel, quiet = false): void {
    this.level = level;
    this.quiet = quiet;
  }

  public error(message: string): void {
    this.emit("error", message);
  }

  public warn(message: string): void {
    this.emit("warn", message);
  }

  public info(message: string): void {
    this.emit("info", message);
  }

  public debug(message: string): void {
    this.emit("debug", message);
  }

  private emit(level: LogLevel, message: string): void {
    if (this.quiet && level !== "error") return;
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.level]) return;
    const prefix = level === "debug" ? "debug:" : "";
    const line = prefix ? `${prefix} ${message}` : message;
    process.stderr.write(line + "\n");
  }
}

export const logger = new Logger();
