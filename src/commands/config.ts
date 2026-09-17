import { loadConfig, saveConfig, setConfigValue } from "../core/config.js";
import { configPath } from "../core/paths.js";
import { emitJson, type GlobalOptions } from "./context.js";

/** glm-router config show (spec §28). */
export function configShowCommand(options: GlobalOptions, deps: { home?: string } = {}): number {
  const config = loadConfig(deps.home);
  if (options.json) {
    emitJson({ path: configPath(deps.home), config });
    return 0;
  }
  const lines = [
    `Provider: Z.ai`,
    `Main model: ${config.models.main}`,
    `Fast model: ${config.models.fast}`,
    "",
    "Worker:",
    `  max turns: ${config.worker.maxTurns}`,
    "",
    "Review:",
    `  max turns: ${config.review.maxTurns}`,
    "",
    "Integrations:",
    `  Claude: ${config.integrations.claude ? "enabled" : "disabled"}`,
    `  Codex: ${config.integrations.codex ? "enabled" : "disabled"}`,
    `  Codex skill: ${config.integrations.codexSkill ? "enabled" : "disabled"}`,
    "",
    `Config file: ${configPath(deps.home)}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

/** glm-router config set <dotted.key> <value> (spec §28). */
export function configSetCommand(
  key: string,
  value: string,
  _options: GlobalOptions,
  deps: { home?: string } = {},
): number {
  const config = loadConfig(deps.home);
  const updated = setConfigValue(config, key, value);
  saveConfig(updated, deps.home);
  process.stdout.write(`✓ ${key} = ${value}\n`);
  return 0;
}
