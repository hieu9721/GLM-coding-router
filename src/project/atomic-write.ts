import fs from "node:fs";
import path from "node:path";

/**
 * Atomic file replacement (spec §22): write tmp → fsync → rename.
 * On failure the original file is left untouched. Callers translate
 * filesystem errors into their own actionable errors.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.glm-tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}
