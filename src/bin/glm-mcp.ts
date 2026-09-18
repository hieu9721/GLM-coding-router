#!/usr/bin/env node
import readline from "node:readline";
import { isMainModule } from "../core/main-guard.js";
import { createMcpServer } from "../mcp/server.js";

/**
 * glm-mcp (specs/v1-architecture.md): MCP server over stdio. Responses are
 * serialized through a write queue so concurrent tool calls can never
 * interleave frames. Stderr stays free for anything unexpected.
 */
if (isMainModule(import.meta.url)) {
  const server = createMcpServer();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let queue: Promise<void> = Promise.resolve();

  rl.on("line", (line: string) => {
    queue = queue.then(async () => {
      const frame = await server.handleLine(line);
      if (frame !== null) {
        process.stdout.write(`${frame}\n`);
      }
    });
  });
  rl.on("close", () => {
    void queue.then(() => process.exit(0));
  });
}
