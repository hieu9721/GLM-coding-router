import { Errors } from "./errors.js";

/** The router's own routing flags, stripped out of argv before the prompt is read. */
export interface RoutingFlags {
  /** argv with every routing flag removed. */
  readonly rest: string[];
  /** `--model main|fast`: pins the model. Does NOT bypass an enforced refusal. */
  readonly model?: "main" | "fast";
  /** `--force`: bypass an enforced preflight refusal (exit 41). */
  readonly force: boolean;
  /** `--refresh-quota`: bypass the 60 s quota cache for this run's preflight read. */
  readonly refreshQuota: boolean;
}

/** The only two values `--model` takes; the router routes between config slots, not model names. */
const MODEL_SLOTS = ["main", "fast"] as const;

/**
 * Remove the router's Phase E flags from argv (specs/v2-architecture.md).
 *
 * Every occurrence is consumed, including repeats, because whatever is left in
 * `rest` becomes the PROMPT — `resolvePrompt` joins it — so a flag that
 * survives this function does not reach Claude as a flag, it silently becomes
 * task text. That is why an unknown `--model` value is an error rather than a
 * pass-through: quietly appending "--model gpt-4" to someone's prompt is worse
 * than telling them the flag takes main or fast.
 *
 * Like `--profile` (specs/glm-fast-profiles.md), our `--model` deliberately
 * shadows Claude Code's own flag of that name inside these binaries; callers
 * who need Claude's version can call `claude` directly.
 */
export function extractRoutingFlags(argv: readonly string[]): RoutingFlags {
  const rest: string[] = [];
  let model: "main" | "fast" | undefined;
  let force = false;
  let refreshQuota = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--refresh-quota") {
      refreshQuota = true;
      continue;
    }
    if (arg === "--model") {
      // The first occurrence wins, but later ones are still consumed so they
      // cannot leak into the prompt.
      model ??= parseSlot(argv[i + 1]);
      i++;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model ??= parseSlot(arg.slice("--model=".length));
      continue;
    }
    rest.push(arg);
  }

  return { rest, model, force, refreshQuota };
}

function parseSlot(value: string | undefined): "main" | "fast" {
  if (value === undefined || !MODEL_SLOTS.includes(value as "main" | "fast")) {
    throw Errors.invalidArgs(
      `--model expects "main" or "fast"${value === undefined ? "" : `, got "${value}"`}.`,
      [
        "Pick the configured slot, not a model name:",
        "",
        "  glm-worker --model fast \"<task>\"",
        "",
        "The names behind the slots come from models.main / models.fast in config.",
      ],
    );
  }
  return value as "main" | "fast";
}
