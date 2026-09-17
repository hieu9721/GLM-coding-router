import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RouterConfig } from "./config.js";
import { Errors } from "./errors.js";
import { isWindows } from "./platform.js";

function runWhere(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const finder = isWindows() ? "where.exe" : "which";
  try {
    const output = execFileSync(finder, [name], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Manual PATH scan for candidate executables, preferring .exe over shims (spec §33). */
export function searchPathFor(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH ?? "";
  const separators = isWindows() ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = pathValue.split(path.delimiter).filter((d) => d.length > 0);
  const candidates: string[] = [];
  for (const dir of dirs) {
    for (const ext of separators) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  const exe = candidates.find((c) => c.toLowerCase().endsWith(".exe"));
  return exe ?? candidates[0];
}

function isExecutableFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Prefer native executables; npm .cmd shims are a last resort (spec §33). */
function preferNative(matches: string[]): string | undefined {
  return matches.find((m) => m.toLowerCase().endsWith(".exe")) ?? matches[0];
}

/**
 * Locate claude.exe (spec §33):
 *   1. where.exe claude
 *   2. PATH search through Node
 *   3. config override
 *   4. error
 *
 * `env` defaults to `process.env` and is threaded through for testability —
 * production callers never pass it.
 */
export function locateClaude(config?: RouterConfig, env: NodeJS.ProcessEnv = process.env): string {
  const matches = runWhere("claude", env);
  const fromWhere = preferNative(matches);
  if (fromWhere) {
    return fromWhere;
  }
  const fromPath = searchPathFor("claude", env);
  if (fromPath) {
    return fromPath;
  }
  const override = config?.claudePath;
  if (override && isExecutableFile(override)) {
    return override;
  }
  const detail =
    override && !isExecutableFile(override)
      ? `Configured claudePath override does not exist: ${override}`
      : undefined;
  throw Errors.claudeNotFound(detail);
}

/**
 * Locate codex (spec §34). Absence is a WARN for doctor, not an error here —
 * the tool must work with a Claude-only setup. `required` callers
 * (glm commands that need codex) get a proper error.
 */
export function locateCodex(config?: RouterConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const matches = runWhere("codex", env);
  if (matches.length > 0) {
    return preferNative(matches);
  }
  const fromPath = searchPathFor("codex", env);
  if (fromPath) {
    return fromPath;
  }
  const override = config?.codexPath;
  if (override && isExecutableFile(override)) {
    return override;
  }
  return undefined;
}

export function codexRequired(config?: RouterConfig, env: NodeJS.ProcessEnv = process.env): string {
  const found = locateCodex(config, env);
  if (!found) {
    throw Errors.codexNotFound();
  }
  return found;
}
