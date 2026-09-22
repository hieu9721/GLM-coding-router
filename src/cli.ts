#!/usr/bin/env node
import { Command } from "commander";
import { version } from "./core/version.js";
import { ExitCode } from "./core/errors.js";
import { isMainModule } from "./core/main-guard.js";
import { applyGlobalOptions, reportError, type GlobalOptions } from "./commands/context.js";
import { landingCommand } from "./commands/landing.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor-command.js";
import { statusCommand } from "./commands/status.js";
import { keyCheckCommand, keySetCommand } from "./commands/key.js";
import { configSetCommand, configShowCommand } from "./commands/config.js";
import { projectInitCommand } from "./commands/project-init.js";
import { projectRemoveCommand } from "./commands/project-remove.js";
import { skillInstallCommand, skillRemoveCommand } from "./commands/skill.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { delegateCommand } from "./commands/delegate.js";
import { benchmarkCommand } from "./commands/benchmark.js";
import { usageCommand } from "./commands/usage.js";
import { runsCleanCommand, runsCommand, runsLogsCommand, runsShowCommand } from "./commands/runs.js";
import { watchCommand } from "./commands/watch.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { mcpCommand } from "./commands/mcp.js";

const program = new Command();

program
  .name("glm-router")
  .description("GLM Coding Plan workers for Claude Code and Codex")
  .version(version);

program
  .option("--json", "machine-readable JSON output")
  .option("--quiet", "suppress non-error output")
  .option("--verbose", "debug-level output")
  .option("--dry-run", "preview file modifications without writing")
  .option("--force", "apply actions even when already done")
  .option("--yes", "assume defaults for all prompts")
  // No subcommand: an offline landing page (specs/terminal-ui-doctor.md §B.1),
  // not a call into any command that reads config/credentials or the network.
  .action(() => execute(() => Promise.resolve(landingCommand(globalOptions()))));

/** Shared action wrapper: apply global flags, catch errors, set the exit code. */
async function execute(action: () => Promise<number>): Promise<void> {
  applyGlobalOptions(globalOptions());
  try {
    process.exitCode = await action();
  } catch (error) {
    process.exitCode = reportError(error);
  }
}

function globalOptions(): GlobalOptions {
  return program.opts<GlobalOptions>();
}

program
  .command("init")
  .description("guided setup: environment check, key, config, integrations")
  .action(() => execute(() => initCommand(globalOptions())));

program
  .command("doctor")
  .description("diagnose the full runtime, authenticating the effective Z.ai key by default")
  .option("--network", "also probe Anthropic endpoint reachability")
  .option("--offline", "local checks only; skip online key authentication")
  .action((commandOptions: { network?: boolean; offline?: boolean }) =>
    execute(() => doctorCommand({ ...globalOptions(), ...commandOptions })),
  );

program
  .command("status")
  .description("quick offline status overview")
  .action(() => execute(() => Promise.resolve(statusCommand(globalOptions()))));

const key = program.command("key").description("manage the Z.ai Coding Plan API key");
key
  .command("set")
  .description("prompt for and store the key in the Windows User Environment")
  .action(() => execute(() => keySetCommand(globalOptions())));
key
  .command("check")
  .description("report whether the key is configured and from which source")
  .action(() => execute(() => Promise.resolve(keyCheckCommand(globalOptions()))));

const config = program.command("config").description("show or change configuration");
config
  .command("show")
  .description("print the effective configuration")
  .action(() => execute(() => Promise.resolve(configShowCommand(globalOptions()))));
config
  .command("set <key> <value>")
  .description("set a dotted config value, e.g. models.main glm-5.3")
  .action((keyPath: string, value: string) =>
    execute(() => Promise.resolve(configSetCommand(keyPath, value, globalOptions()))),
  );

const project = program.command("project").description("per-project CLAUDE.md / AGENTS.md integration");
project
  .command("init")
  .description("create or update the GLM delegation managed blocks")
  .action(() => execute(() => Promise.resolve(projectInitCommand(globalOptions()))));
project
  .command("remove")
  .description("remove the managed blocks, preserving user content")
  .action(() => execute(() => Promise.resolve(projectRemoveCommand(globalOptions()))));

const skill = program.command("skill").description("manage the optional Codex delegation skill");
skill
  .command("install")
  .description("install the glm-delegation skill for Codex")
  .action(() => execute(() => Promise.resolve(skillInstallCommand(globalOptions()))));
skill
  .command("remove")
  .description("remove the glm-delegation skill")
  .action(() => execute(() => Promise.resolve(skillRemoveCommand(globalOptions()))));

program
  .command("delegate <name> [prompt...]")
  .description("run a GLM worker in an isolated git worktree (branch glm/delegate/<name>)")
  .option("--profile <name>", "profile overlay (defaults to a profile named <name> if defined)")
  .option("--remove", "remove the worktree after a successful run (branch is always kept)")
  .action((name: string, prompt: string[], commandOptions: { profile?: string; remove?: boolean }) =>
    execute(() => delegateCommand(name, prompt, { ...globalOptions(), ...commandOptions })),
  );

program
  .command("benchmark")
  .description("measure the Claude+GLM stack on built-in coding tasks (makes real GLM calls)")
  .option("--task <id>", "run only this task (repeatable)", (value: string, previous: string[]) => previous.concat([value]), [])
  .option("--stack <name>", "orchestration stack (default claude; codex not yet supported)")
  .option("--max-turns <n>", "worker --max-turns override", (value: string) => Number(value))
  .option("--repeat <n>", "run each task N times", (value: string) => Number(value))
  .action((commandOptions: { task?: string[]; stack?: string; maxTurns?: number; repeat?: number }) =>
    execute(() => benchmarkCommand({ ...globalOptions(), ...commandOptions })),
  );

program
  .command("usage")
  .description("provider usage snapshots: Z.ai Coding Plan quota + local benchmark totals")
  .action(() => execute(() => usageCommand(globalOptions())));

const runs = program
  .command("runs")
  .description("inspect recorded worker runs — the default action lists them")
  .option("--active", "list only runs in the active registry")
  .option("--limit <n>", "show at most N runs (default 20)", (value: string) => Number(value))
  .option("--json", "machine-readable JSON output")
  .action((commandOptions: { active?: boolean; limit?: number; json?: boolean }) =>
    execute(() => Promise.resolve(runsCommand({ ...globalOptions(), ...commandOptions }))),
  );
runs
  .command("show <id>")
  .description("show one run: metadata, summary numbers, per-turn tool tree")
  .option("--json", "machine-readable JSON output")
  .action((id: string, commandOptions: { json?: boolean }) =>
    execute(() => Promise.resolve(runsShowCommand(id, { ...globalOptions(), ...commandOptions }))),
  );
runs
  .command("logs <id>")
  .description("render the run's events.jsonl, one line per event")
  .option("--json", "print the raw events.jsonl lines unchanged")
  .action((id: string, commandOptions: { json?: boolean }) =>
    execute(() => Promise.resolve(runsLogsCommand(id, { ...globalOptions(), ...commandOptions }))),
  );
runs
  .command("clean")
  .description("prune history by age/count and reap orphaned active runs")
  .option("--older-than <nd>", 'prune runs older than N days, e.g. "30d" (default: history.retentionDays)')
  .option("--orphans", "reap active runs whose heartbeat is stale and whose pid is dead")
  .option("--dry-run", "print what would happen without changing anything")
  .option("--json", "machine-readable JSON output")
  .action((commandOptions: { olderThan?: string; orphans?: boolean; dryRun?: boolean; json?: boolean }) =>
    execute(() => Promise.resolve(runsCleanCommand({ ...globalOptions(), ...commandOptions }))),
  );

program
  .command("watch [run-id]")
  .description("attach to a running run and follow its progress live (newest active run by default)")
  .option("--from-start", "render the events written before attaching, then follow")
  .action((runId: string | undefined, commandOptions: { fromStart?: boolean }) =>
    execute(() => watchCommand({ ...globalOptions(), runId, ...commandOptions })),
  );

program
  .command("dashboard")
  .description("quota + active runs + recent runs: one snapshot when piped, a live view on a TTY")
  .option("--interval <seconds>", "repaint interval in seconds on a TTY (default 2)", (value: string) => Number(value))
  .action((commandOptions: { interval?: number }) =>
    execute(() => dashboardCommand({ ...globalOptions(), ...commandOptions })),
  );

const mcp = program
  .command("mcp")
  .description("optional glm-mcp MCP server: snippet, install, remove")
  .action(() => execute(() => mcpCommand(globalOptions(), "info")));
mcp
  .command("install")
  .description("register glm-mcp with Claude Code (claude mcp add -s user)")
  .action(() => execute(() => mcpCommand(globalOptions(), "install")));
mcp
  .command("remove")
  .description("unregister glm-mcp from Claude Code (claude mcp remove -s user)")
  .action(() => execute(() => mcpCommand(globalOptions(), "remove")));

program
  .command("uninstall")
  .description("guided removal (keeps ZAI_API_KEY by default)")
  .action(() => execute(() => uninstallCommand(globalOptions())));

export async function main(argv: string[]): Promise<number> {
  try {
    // argv is the full process.argv; commander's default "node" origin strips
    // the executable and script path itself.
    await program.parseAsync(argv);
  } catch (error) {
    process.stderr.write(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
    process.exitCode = ExitCode.InvalidArgs;
  }
  return Number(process.exitCode ?? ExitCode.Success);
}

if (isMainModule(import.meta.url)) {
  void main(process.argv).then((code) => process.exit(code));
}
