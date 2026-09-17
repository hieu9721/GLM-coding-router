import fs from "node:fs";
import path from "node:path";
import { Errors } from "../core/errors.js";
import { hasManagedBlock, removeManagedBlock, upsertManagedBlock } from "./managed-block.js";
import { atomicWriteFile } from "./atomic-write.js";
import { forgetFile, isOwnedFile, recordCreatedFile } from "./ownership.js";

export interface ManagedFileChange {
  readonly file: string;
  /** True when the file did not exist before this operation. */
  readonly created: boolean;
  /** True when on-disk content will change (or would change under --dry-run). */
  readonly changed: boolean;
  readonly oldContent: string;
  readonly newContent: string;
  /** True when the file itself was (or would be) deleted. */
  readonly deleted: boolean;
}

export interface ManagedFileOptions {
  /** Absolute path to the managed file (e.g. <root>\CLAUDE.md). */
  readonly file: string;
  /** Block body (with markers) to upsert. */
  readonly block: string;
  /** Home dir override for ownership metadata (tests). */
  readonly home?: string;
  readonly dryRun?: boolean;
}

function toChange(
  file: string,
  created: boolean,
  oldContent: string,
  newContent: string,
  deleted = false,
): ManagedFileChange {
  return {
    file,
    created,
    changed: oldContent !== newContent || deleted,
    oldContent,
    newContent,
    deleted: deleted,
  };
}

/** Insert or replace the managed block in a file, atomically (spec §21, §22). */
export function upsertManagedFile(options: ManagedFileOptions): ManagedFileChange {
  const { file, block, home, dryRun } = options;
  const fileName = path.basename(file);
  const existed = fs.existsSync(file);
  const oldContent = existed ? fs.readFileSync(file, "utf8") : "";
  const newContent = upsertManagedBlock(oldContent, block, fileName);

  if (!dryRun && newContent !== oldContent) {
    try {
      atomicWriteFile(file, newContent);
    } catch (cause) {
      throw Errors.managedFileWriteFailed(
        file,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    if (!existed) {
      recordCreatedFile(file, home);
    }
  }

  return toChange(file, !existed, oldContent, newContent);
}

/** Remove the managed block; delete router-created files that become empty (spec §43). */
export function removeManagedFile(
  file: string,
  home?: string,
  dryRun = false,
): ManagedFileChange {
  const fileName = path.basename(file);
  if (!fs.existsSync(file)) {
    return toChange(file, false, "", "", false);
  }
  const oldContent = fs.readFileSync(file, "utf8");

  if (!hasManagedBlock(oldContent)) {
    return toChange(file, false, oldContent, oldContent, false);
  }

  const newContent = removeManagedBlock(oldContent, fileName);
  const owned = isOwnedFile(file, home);
  const emptyAfterRemove = newContent.length === 0;

  if (dryRun) {
    return toChange(file, false, oldContent, newContent, owned && emptyAfterRemove);
  }

  try {
    if (emptyAfterRemove && owned) {
      fs.rmSync(file);
      forgetFile(file, home);
      return toChange(file, false, oldContent, newContent, true);
    }
    if (newContent !== oldContent) {
      atomicWriteFile(file, newContent);
    }
  } catch (cause) {
    throw Errors.managedFileWriteFailed(
      file,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  return toChange(file, false, oldContent, newContent, false);
}
