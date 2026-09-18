import { spawn, type ChildProcess } from "node:child_process";
import { Errors } from "./errors.js";

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
