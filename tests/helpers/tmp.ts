import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Fresh temp dir per test; caller is responsible for cleanup via returned path. */
export function makeTempDir(prefix = "glm-router-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function writeFileSyncAll(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

export function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}
