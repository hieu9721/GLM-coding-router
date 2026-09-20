import prompts from "prompts";
import { Errors, formatGlmError } from "../core/errors.js";
import { logger } from "../core/logging.js";
import {
  describeKeyStore,
  describeShellExport,
  detectUserEnvStore,
  type UserEnvStore,
} from "../core/user-env.js";
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
  /** Defaults to this machine's detected store — injected by tests. */
  readonly store?: UserEnvStore;
  readonly home?: string;
}

/**
 * Print the shell-profile guidance used when the platform has no persistent
 * secret store (the common Linux case: `secret-tool` is not installed by
 * default). specs/cross-platform.md.
 */
export function printShellKeyGuidance(deps: Pick<KeyDeps, "env" | "home"> = {}): void {
  const { line, profile } = describeShellExport(ZAI_API_KEY_ENV, {
    env: deps.env,
    home: deps.home,
  });
  process.stdout.write(
    [
      `This platform has ${describeKeyStore("none")} that ${ZAI_API_KEY_ENV} can be saved to,`,
      "so set it yourself — it takes one line:",
      "",
      `  ${line}`,
      "",
      `Add that to ${profile} so new shells inherit it, then run:`,
      "",
      "  glm-router key check",
      "",
      "The current shell keeps its old environment until you re-source that file",
      "or open a new terminal.",
      "",
    ].join("\n"),
  );
}

/** glm-router key set (spec §11): prompt, save to Windows User Environment. */
export async function keySetCommand(
  _options: GlobalOptions,
  deps: KeyDeps = {},
): Promise<number> {
  const store = deps.store ?? detectUserEnvStore();
  if (store === "none") {
    printShellKeyGuidance(deps);
    return 0;
  }

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
    logger.error(
      `Failed to write ${describeKeyStore(store)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  process.stdout.write(`\n✓ Saved to ${describeKeyStore(store)}:\n  ${ZAI_API_KEY_ENV}\n`);
  process.stdout.write("\nOpen a NEW terminal (or restart your Orca terminal) so the current process picks it up.\n");
  return 0;
}

/** glm-router key check (spec §11): report presence + source; never the value. */
export function keyCheckCommand(
  options: GlobalOptions,
  deps: Pick<KeyDeps, "env" | "readUserEnv" | "store"> = {},
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
    // Formatted per spec §36; exit 10 (spec §35). The hint is platform-aware,
    // so it never points at a command that cannot finish the job here.
    const error = Errors.zaiKeyMissing();
    process.stderr.write(formatGlmError(error) + "\n");
    return error.exitCode;
  }
  const sourceLabel =
    resolved.source === "process-env"
      ? "process environment"
      : describeKeyStore(deps.store ?? detectUserEnvStore());
  process.stdout.write(`${ZAI_API_KEY_ENV}: configured\nSource: ${sourceLabel}\n`);
  return 0;
}

/** Used by uninstall; keeps the key by default (spec §44). */
export async function keyRemoveCommand(
  deps: Pick<KeyDeps, "deleteEnv" | "store"> = {},
): Promise<void> {
  const store = deps.store ?? detectUserEnvStore();
  if (store === "none") {
    // Nothing this tool owns; the key lives in a shell profile the user wrote.
    process.stdout.write(
      `${ZAI_API_KEY_ENV} is not stored by glm-router on this platform — remove the export line from your shell profile.\n`,
    );
    return;
  }
  const deleteEnv = deps.deleteEnv ?? deleteWindowsUserEnv;
  deleteEnv(ZAI_API_KEY_ENV);
}
