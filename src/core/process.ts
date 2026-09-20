import { spawn, type ChildProcess } from "node:child_process";
import { Errors } from "./errors.js";
import { logger } from "./logging.js";

export interface SpawnAgentOptions {
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** true (default) inherits stdin too — interactive sessions. */
  readonly interactive?: boolean;
}

export interface CapturedResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnStreamOptions extends SpawnAgentOptions {
  readonly onStdoutLine: (line: string) => void;
  readonly onStderrLine: (line: string) => void;
  /** Handed the child as soon as it exists, so a later phase can terminate it. */
  readonly onSpawn?: (child: ChildProcess) => void;
}

/**
 * Spawn a child agent process (spec §18, §32, §39):
 * - argument array, never a shell string
 * - inherits cwd and stdout/stderr
 * - forwards SIGINT/SIGTERM so Ctrl+C reaches the child
 * - resolves with the child's exit code (signals resolve to 1)
 */
export function spawnAgent(binPath: string, options: SpawnAgentOptions): Promise<number> {
  const { args, cwd, env, interactive = true } = options;
  return new Promise<number>((resolve, reject) => {
    const child = spawn(binPath, args, {
      cwd,
      env,
      stdio: interactive ? "inherit" : ["ignore", "inherit", "inherit"],
      shell: false,
      windowsHide: false,
    });
    const handlers = forwardSignals(child);
    child.on("error", (error) => {
      removeSignals(handlers);
      reject(Errors.childAgentFailed(errorMessage(error)));
    });
    child.on("exit", (code) => {
      removeSignals(handlers);
      resolve(code ?? 1);
    });
  });
}

/**
 * Like spawnAgent but pipes stdout/stderr instead of inheriting them and
 * resolves the captured output (specs/benchmark.md) — same no-shell rule and
 * signal forwarding. Used by `benchmark` to parse the child's result JSON.
 */
export function spawnAgentCapture(binPath: string, options: SpawnAgentOptions): Promise<CapturedResult> {
  const { args, cwd, env } = options;
  return new Promise<CapturedResult>((resolve, reject) => {
    const child = spawn(binPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const handlers = forwardSignals(child);
    child.on("error", (error) => {
      removeSignals(handlers);
      reject(Errors.childAgentFailed(errorMessage(error)));
    });
    child.on("exit", (code) => {
      removeSignals(handlers);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Like spawnAgentCapture, but delivers every complete stdout/stderr line the
 * moment it arrives (v2 spec Phase D) instead of buffering the whole output
 * until exit — that buffering is exactly what makes live progress impossible.
 * Same no-shell argv rule and signal forwarding. A chunk boundary can fall
 * inside a JSON object, so each stream carries its own partial-line buffer;
 * blank lines are dropped, and a trailing line without a newline is flushed
 * before the promise resolves — a crashed agent's last line is still evidence.
 * A throwing callback is reported at debug level and never kills the run.
 */
export function spawnAgentStream(binPath: string, options: SpawnStreamOptions): Promise<{ code: number }> {
  const { args, cwd, env, onStdoutLine, onStderrLine, onSpawn } = options;
  return new Promise<{ code: number }>((resolve, reject) => {
    const child = spawn(binPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: false,
    });
    if (onSpawn) {
      try {
        onSpawn(child);
      } catch (error) {
        logger.debug(`spawnAgentStream: onSpawn callback failed: ${errorMessage(error)}`);
      }
    }
    const stdout = createLineSplitter(onStdoutLine);
    const stderr = createLineSplitter(onStderrLine);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));

    const handlers = forwardSignals(child);
    child.on("error", (error) => {
      removeSignals(handlers);
      reject(Errors.childAgentFailed(errorMessage(error)));
    });
    // "close", not "exit": it fires once the stdio streams are drained, so the
    // trailing-line flush below cannot race data still sitting in the pipe.
    child.on("close", (code) => {
      removeSignals(handlers);
      stdout.flush();
      stderr.flush();
      resolve({ code: code ?? 1 });
    });
  });
}

/** Per-stream line buffer for spawnAgentStream: emits each complete line (\n or \r\n) as it arrives. */
function createLineSplitter(deliver: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let buffer = "";
  const emit = (line: string): void => {
    if (line.length === 0) return;
    try {
      deliver(line);
    } catch (error) {
      logger.debug(`spawnAgentStream: line callback failed: ${errorMessage(error)}`);
    }
  };
  return {
    push(chunk) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        emit(line.endsWith("\r") ? line.slice(0, -1) : line);
        newline = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.length > 0) {
        const line = buffer;
        buffer = "";
        emit(line);
      }
    },
  };
}

type SignalHandlers = Map<NodeJS.Signals, () => void>;

/** Install SIGINT/SIGTERM forwarding; returns the handlers for cleanup. */
function forwardSignals(child: ChildProcess): SignalHandlers {
  const handlers: SignalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      if (child.killed) return;
      try {
        child.kill(signal);
      } catch {
        // Child already gone; the exit event settles the promise.
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return handlers;
}

function removeSignals(handlers: SignalHandlers): void {
  for (const [signal, handler] of handlers) {
    process.removeListener(signal, handler);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
