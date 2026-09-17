import { Errors } from "./errors.js";

/** Read all of stdin when it is not a TTY; resolve undefined otherwise (spec §40). */
export function readStdin(): Promise<string | undefined> {
  const stdin = process.stdin;
  if (stdin.isTTY) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    stdin.on("end", () => resolve(data.length > 0 ? data : undefined));
    stdin.on("error", () => resolve(undefined));
  });
}

/**
 * Resolve the task prompt (spec §15, §40):
 *   stdin text → joined arguments → error
 */
export async function resolvePrompt(
  argv: readonly string[],
  readStdinFn: () => Promise<string | undefined> = readStdin,
  command = "glm-worker",
): Promise<string> {
  const stdinText = await readStdinFn();
  if (stdinText !== undefined && stdinText.trim().length > 0) {
    return stdinText;
  }
  const argText = argv.join(" ").trim();
  if (argText.length > 0) {
    return argText;
  }
  throw Errors.promptRequired(command);
}
