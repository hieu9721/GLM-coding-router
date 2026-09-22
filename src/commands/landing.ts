/**
 * `glm-router` with no subcommand (specs/terminal-ui-doctor.md §B.1). Purely
 * static: no provider request, no key/config read, no side effects. Exists
 * so a first-time user sees "what do I run" instead of nothing.
 */
import { Errors } from "../core/errors.js";
import { version } from "../core/version.js";
import { createCommandUi } from "../tui/command-ui.js";
import { createWriter, type Writer } from "../tui/render.js";
import type { GlobalOptions } from "./context.js";

export interface LandingDeps {
  readonly stdout?: NodeJS.WriteStream;
}

export function landingCommand(options: GlobalOptions, deps: LandingDeps = {}): number {
  if (options.json) {
    // Root --json has no data to emit — a data-producing command must be named.
    throw Errors.invalidArgs("--json requires a command that produces data.", [
      "Try:", "", "  glm-router status --json", "  glm-router doctor --json", "  glm-router usage --json",
    ]);
  }

  const stream = deps.stdout ?? process.stdout;
  const writer: Writer = createWriter(stream);
  const ui = createCommandUi(writer, { quiet: options.quiet });

  const blocks: string[] = [];
  const header = ui.header(`GLM CODING ROUTER  v${version}`, "Coding Plan workers for Claude Code and Codex");
  if (header) blocks.push(header);

  blocks.push(
    [
      ui.section("CHECK & MONITOR"),
      ui.row("glm-router doctor", "Check setup and verify API key"),
      ui.row("glm-router status", "Quick offline overview"),
      ui.row("glm-router usage", "Coding Plan quota and reset times"),
      ui.row("glm-router dashboard", "Live quota and worker activity"),
    ].join("\n"),
  );
  blocks.push(
    [
      ui.section("WORK"),
      ui.row('glm-worker "<task>"', "Run an implementation task"),
      ui.row('glm-review "<task>"', "Run a read-only review"),
      ui.row("glm-router runs", "Inspect recorded runs"),
    ].join("\n"),
  );
  blocks.push(
    [
      ui.section("SETUP"),
      ui.row("glm-router init", "Guided setup"),
      ui.row("glm-router key set", "Save a replacement API key"),
    ].join("\n"),
  );

  const footer = ui.footer("Start with: glm-router doctor\nAll commands: glm-router --help");
  if (footer) blocks.push(footer);

  writer.line(blocks.join("\n\n"));
  return 0;
}
