import os from "node:os";
import path from "node:path";

/** Config directory: %USERPROFILE%\.glm-coding-router (spec §13). */
export function configDir(home: string = os.homedir()): string {
  return path.join(home, ".glm-coding-router");
}

export function configPath(home: string = os.homedir()): string {
  return path.join(configDir(home), "config.json");
}

/** Local metadata tracking which project files this tool created entirely (spec §43). */
export function ownershipPath(home: string = os.homedir()): string {
  return path.join(configDir(home), "ownership.json");
}
