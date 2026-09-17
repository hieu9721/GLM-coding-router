import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

/**
 * True when this module is the entry point (node dist/bin/glm-worker.js).
 * Robust against URL-encoded characters and symlinks.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(importMetaUrl));
    const invoked = fs.realpathSync(path.resolve(entry));
    return self === invoked;
  } catch {
    return false;
  }
}
