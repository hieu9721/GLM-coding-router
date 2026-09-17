import fs from "node:fs";
import path from "node:path";
import { ownershipPath } from "../core/paths.js";

interface OwnershipRecord {
  /** Absolute file paths this tool created entirely (spec §43). */
  readonly files: Record<string, { createdAt: string }>;
}

function readRecords(home?: string): OwnershipRecord {
  const file = ownershipPath(home);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OwnershipRecord>;
    if (raw && typeof raw.files === "object" && raw.files !== null) {
      return { files: raw.files };
    }
  } catch {
    // Missing or corrupt metadata is non-fatal: fall back to empty.
  }
  return { files: {} };
}

function writeRecords(record: OwnershipRecord, home?: string): void {
  const file = ownershipPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function recordCreatedFile(filePath: string, home?: string): void {
  const normalized = path.resolve(filePath);
  const records = readRecords(home);
  if (normalized in records.files) return;
  records.files[normalized] = { createdAt: new Date().toISOString() };
  writeRecords(records, home);
}

export function isOwnedFile(filePath: string, home?: string): boolean {
  return path.resolve(filePath) in readRecords(home).files;
}

export function forgetFile(filePath: string, home?: string): void {
  const normalized = path.resolve(filePath);
  const records = readRecords(home);
  if (!(normalized in records.files)) return;
  delete records.files[normalized];
  writeRecords(records, home);
}
