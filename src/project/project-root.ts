import { execFileSync } from "node:child_process";
import path from "node:path";
import { logger } from "../core/logging.js";

/**
 * Project root detection (spec §19):
 *   git rev-parse --show-toplevel → cwd
 */
export function findProjectRoot(cwd: string = process.cwd()): string {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const root = output.trim();
    if (root.length > 0) {
      // git prints forward slashes on Windows; normalize for the platform.
      return path.resolve(root);
    }
  } catch (error) {
    logger.debug(`git rev-parse failed (${error instanceof Error ? error.message : "unknown"}); using cwd`);
  }
  return cwd;
}
