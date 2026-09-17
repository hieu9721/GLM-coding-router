import { spawn } from "node:child_process";
import { Errors } from "./errors.js";

export interface SpawnAgentOptions {
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** true (default) inherits stdin too — interactive sessions. */
  readonly interactive?: boolean;
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
    let child;
    try {
      child = spawn(binPath, args, {
        cwd,
        env,
        stdio: interactive ? "inherit" : ["ignore", "inherit", "inherit"],
        shell: false,
        windowsHide: false,
      });
    } catch (error) {
      reject(Errors.childAgentFailed(errorMessage(error)));
      return;
    }

    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of signals) {
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

    const cleanup = (): void => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    };

    child.on("error", (error) => {
      cleanup();
      reject(Errors.childAgentFailed(errorMessage(error)));
    });

    child.on("exit", (code) => {
      cleanup();
      resolve(code ?? 1);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
