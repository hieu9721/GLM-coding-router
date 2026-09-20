import os from "node:os";
import { Errors } from "./errors.js";

/** Platforms this package supports (specs/cross-platform.md). */
export type PlatformSupport = "supported" | "experimental" | "unsupported";

export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Support level per platform:
 *   win32  — verified through the registry-verification ritual
 *   linux  — verified 2026-09-20 on Ubuntu 24.04
 *   darwin — designed but never executed; no Mac has run the suite
 */
export function platformSupport(platform: NodeJS.Platform = process.platform): PlatformSupport {
  if (platform === "win32" || platform === "linux") return "supported";
  if (platform === "darwin") return "experimental";
  return "unsupported";
}

export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platformSupport(platform) !== "unsupported";
}

/** Human-readable platform name for doctor/status. */
export function platformName(
  platform: NodeJS.Platform = process.platform,
  release: string = os.release(),
): string {
  if (platform === "win32") {
    const build = Number.parseInt(release.split(".")[2] ?? "0", 10);
    return build >= 22000 ? "Windows 11" : "Windows 10";
  }
  if (platform === "darwin") return `macOS (darwin ${release.split(".")[0] ?? "?"})`;
  if (platform === "linux") return `Linux ${release.split("-")[0] ?? release}`;
  return `Platform ${platform}`;
}

/** @deprecated use platformName(); kept so existing callers keep compiling. */
export function windowsVersionName(): string {
  return platformName();
}

/** Guard for the few code paths that are genuinely Windows-only. */
export function assertWindows(): void {
  if (!isWindows()) {
    throw Errors.unsupportedPlatform(process.platform);
  }
}

/** Guard for commands that need a platform this package supports at all. */
export function assertSupportedPlatform(): void {
  if (!isSupportedPlatform()) {
    throw Errors.unsupportedPlatform(process.platform);
  }
}
