import prompts from "prompts";
import { assertWindows } from "../core/platform.js";
import { Errors } from "../core/errors.js";
import { logger } from "../core/logging.js";
import {
  ZAI_API_KEY_ENV,
  deleteWindowsUserEnv,
  resolveZaiApiKey,
  setWindowsUserEnv,
} from "../core/zai-key.js";
import { emitJson, type GlobalOptions } from "./context.js";

/** The slice of the "prompts" API this package uses; test fakes satisfy it. */
export interface PromptQuestion {
  readonly type: "confirm" | "password" | null;
  readonly name: string;
  readonly message?: string;
  readonly initial?: boolean;
  readonly validate?: (value: string) => boolean | string;
}

export type PromptFn = (
  questions: PromptQuestion | PromptQuestion[],
) => Promise<Record<string, unknown>>;

export interface KeyDeps {
  readonly prompt?: PromptFn;
  readonly env?: NodeJS.ProcessEnv;
  readonly readUserEnv?: (name: string) => string | undefined;
  readonly setEnv?: (name: string, value: string) => void;
  readonly deleteEnv?: (name: string) => void;
}

/** glm-router key set (spec §11): prompt, save to Windows User Environment. */
export async function keySetCommand(
  _options: GlobalOptions,
  deps: KeyDeps = {},
): Promise<number> {
  assertWindows();

  const prompt = deps.prompt ?? prompts;
  const setEnv = deps.setEnv ?? setWindowsUserEnv;
  const response = await prompt({
    type: "password",
    name: "key",
    message: "Enter Z.ai Coding Plan API key:",
    validate: (value: string) => (value.trim().length > 0 ? true : "Key cannot be empty"),
  });

  if (response.key === undefined) {
    process.stderr.write("Cancelled.\n");
    return 1;
  }

  const key = String(response.key).trim();
  try {
    setEnv(ZAI_API_KEY_ENV, key);
  } catch (error) {
    logger.error(`Failed to write the Windows User Environment: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  process.stdout.write(`\n✓ Saved to Windows User Environment:\n  ${ZAI_API_KEY_ENV}\n`);
  process.stdout.write("\nOpen a NEW terminal (or restart your Orca terminal) so the current process picks it up.\n");
  return 0;
}

/** glm-router key check (spec §11): report presence + source; never the value. */
export function keyCheckCommand(
  options: GlobalOptions,
  deps: Pick<KeyDeps, "env" | "readUserEnv"> = {},
): number {
  const resolved = resolveZaiApiKey({ env: deps.env, readUserEnv: deps.readUserEnv });
  if (options.json) {
    emitJson({
      configured: Boolean(resolved),
      source: resolved?.source ?? null,
    });
    return resolved ? 0 : 10;
  }
  if (!resolved) {
    // Formatted per spec §36; exit 10 (spec §35).
    const error = Errors.zaiKeyMissing();
    process.stderr.write(`ERROR [${error.codeName}]\n\n${error.message}\n\nRun:\n\n  glm-router key set\n`);
    return error.exitCode;
  }
  const sourceLabel =
    resolved.source === "process-env" ? "process environment" : "Windows User Environment";
  process.stdout.write(`${ZAI_API_KEY_ENV}: configured\nSource: ${sourceLabel}\n`);
  return 0;
}

/** Used by uninstall; keeps the key by default (spec §44). */
export async function keyRemoveCommand(deps: Pick<KeyDeps, "deleteEnv"> = {}): Promise<void> {
  assertWindows();
  const deleteEnv = deps.deleteEnv ?? deleteWindowsUserEnv;
  deleteEnv(ZAI_API_KEY_ENV);
}
