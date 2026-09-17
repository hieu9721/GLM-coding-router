import os from "node:os";
import { Errors } from "./errors.js";

export function isWindows(): boolean {
  return process.platform === "win32";
}

/** Human-readable Windows version from os.release() ("10.0.26200" → "Windows 11"). */
export function windowsVersionName(): string {
  if (!isWindows()) {
    return process.platform;
  }
  const release = os.release();
  const build = Number.parseInt(release.split(".")[2] ?? "0", 10);
  return build >= 22000 ? "Windows 11" : "Windows 10";
}

/** Guard for commands that require Windows-specific machinery (PowerShell user env, etc.). */
export function assertWindows(): void {
  if (!isWindows()) {
    throw Errors.unsupportedPlatform(process.platform);
  }
}
