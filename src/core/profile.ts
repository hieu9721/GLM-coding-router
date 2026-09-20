import { Errors } from "./errors.js";
import type { RouterConfig } from "./config.js";

/** Parsed result of scanning argv for the router's own --profile flag. */
export interface ProfileFlag {
  readonly rest: readonly string[];
  readonly profile?: string;
}

/**
 * Remove the router's --profile flag from argv (specs/glm-fast-profiles.md).
 * Accepts `--profile name` and `--profile=name`; the first occurrence wins,
 * later ones are consumed too so they never leak into the forwarded args.
 */
export function extractProfileFlag(argv: readonly string[]): ProfileFlag {
  const rest: string[] = [];
  let profile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw Errors.configInvalid("--profile requires a profile name");
      }
      profile ??= value;
      i++;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      if (value.length === 0) {
        throw Errors.configInvalid("--profile requires a profile name");
      }
      profile ??= value;
      continue;
    }
    rest.push(arg);
  }
  return { rest, profile };
}

/**
 * Overlay a named profile onto the config (specs/glm-fast-profiles.md):
 * main/fast models plus worker/review maxTurns. Unknown names fail with
 * ERROR [11] listing the defined profiles.
 */
export function applyProfile(config: RouterConfig, name?: string): RouterConfig {
  if (!name) {
    return config;
  }
  const profile = config.profiles[name];
  if (!profile) {
    const known = Object.keys(config.profiles);
    const listed = known.length > 0 ? known.sort().join(", ") : "(none defined)";
    throw Errors.configInvalid(`unknown profile "${name}" — available profiles: ${listed}`);
  }
  return {
    ...config,
    models: {
      main: profile.main ?? config.models.main,
      fast: profile.fast ?? config.models.fast,
    },
    worker: {
      maxTurns: profile.workerMaxTurns ?? config.worker.maxTurns,
      // Profiles tune models and turn budgets, never the Bash allowlist —
      // that is a security setting, not a performance knob.
      allowedBash: config.worker.allowedBash,
    },
    review: { maxTurns: profile.reviewMaxTurns ?? config.review.maxTurns },
  };
}
