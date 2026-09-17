import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Errors } from "./errors.js";
import { configDir, configPath } from "./paths.js";

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
export const DEFAULT_MAIN_MODEL = "glm-5.3";
export const DEFAULT_FAST_MODEL = "glm-5.3-flash";

/** Named model/maxTurns overlay selected via --profile (specs/glm-fast-profiles.md). */
export const ProfileSchema = z.object({
  main: z.string().min(1).optional(),
  fast: z.string().min(1).optional(),
  workerMaxTurns: z.number().int().positive().optional(),
  reviewMaxTurns: z.number().int().positive().optional(),
});

export type ProfileConfig = z.infer<typeof ProfileSchema>;

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1),

  provider: z.object({
    name: z.literal("zai"),
    anthropicBaseUrl: z.string().url(),
  }),

  models: z.object({
    main: z.string().min(1),
    fast: z.string().min(1),
  }),

  worker: z.object({
    maxTurns: z.number().int().positive(),
  }).default({ maxTurns: 20 }),

  review: z.object({
    maxTurns: z.number().int().positive(),
  }).default({ maxTurns: 15 }),

  integrations: z.object({
    claude: z.boolean(),
    codex: z.boolean(),
    codexSkill: z.boolean(),
  }).default({ claude: true, codex: true, codexSkill: true }),

  // Optional executable overrides used by discovery (spec §33, §34).
  claudePath: z.string().min(1).optional(),
  codexPath: z.string().min(1).optional(),

  // Named overlays selected via --profile (specs/glm-fast-profiles.md).
  profiles: z.record(z.string(), ProfileSchema).default({}),
});

export type RouterConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(): RouterConfig {
  return {
    schemaVersion: 1,
    provider: {
      name: "zai",
      anthropicBaseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    },
    models: {
      main: DEFAULT_MAIN_MODEL,
      fast: DEFAULT_FAST_MODEL,
    },
    worker: { maxTurns: 20 },
    review: { maxTurns: 15 },
    integrations: {
      claude: true,
      codex: true,
      codexSkill: true,
    },
    profiles: {},
  };
}

/**
 * Load config from %USERPROFILE%\.glm-coding-router\config.json.
 * A missing file yields defaults; anything present must validate (spec §29).
 */
export function loadConfig(home?: string): RouterConfig {
  const file = configPath(home);
  if (!fs.existsSync(file)) {
    return defaultConfig();
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw Errors.configInvalid(`cannot read ${file}: ${errorMessage(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw Errors.configInvalid(`invalid JSON in ${file}: ${errorMessage(error)}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw Errors.configInvalid(detail);
  }
  return result.data;
}

export function saveConfig(config: RouterConfig, home?: string): void {
  const dir = configDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(home);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Set a dotted config key, e.g. `models.main glm-5.3` (spec §28).
 * Existing numbers/booleans coerce the incoming string; result must re-validate.
 */
export function setConfigValue(
  config: RouterConfig,
  dottedKey: string,
  rawValue: string,
): RouterConfig {
  const keys = dottedKey.split(".");
  if (keys.length === 0 || keys.some((k) => k.length === 0)) {
    throw Errors.configInvalid(`invalid config key "${dottedKey}"`);
  }

  const draft: Record<string, unknown> = structuredClone(config) as Record<string, unknown>;
  let target: Record<string, unknown> = draft;
  for (const key of keys.slice(0, -1)) {
    const next = target[key];
    if (typeof next !== "object" || next === null) {
      throw Errors.configInvalid(`config key "${dottedKey}" does not exist`);
    }
    target = next as Record<string, unknown>;
  }

  const leafKey = keys[keys.length - 1];
  if (!(leafKey in target)) {
    throw Errors.configInvalid(`config key "${dottedKey}" does not exist`);
  }

  const current = target[leafKey];
  let value: unknown = rawValue;
  if (typeof current === "number") {
    const numeric = Number(rawValue);
    if (Number.isNaN(numeric)) {
      throw Errors.configInvalid(`"${dottedKey}" expects a number, got "${rawValue}"`);
    }
    value = numeric;
  } else if (typeof current === "boolean") {
    if (rawValue !== "true" && rawValue !== "false") {
      throw Errors.configInvalid(`"${dottedKey}" expects true or false, got "${rawValue}"`);
    }
    value = rawValue === "true";
  }

  target[leafKey] = value;

  const result = ConfigSchema.safeParse(draft);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw Errors.configInvalid(detail);
  }
  return result.data;
}

/** Config path for messages, independent of home override (used by status/doctor). */
export function describeConfigPath(home?: string): string {
  return configPath(home);
}

export function configDirFor(home?: string): string {
  return path.dirname(configPath(home));
}
