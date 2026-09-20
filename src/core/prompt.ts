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
 *   arguments → stdin text → error
 *
 * Arguments are checked FIRST, and when they carry a prompt stdin is never
 * awaited. The original order was stdin-first, which hangs forever whenever
 * stdin is an open pipe that never reaches EOF — the normal shape under an
 * agent harness, a CI runner or `nohup`. Measured on Windows: with stdin held
 * open, `glm-worker "Reply exactly with X"` did nothing at all — no run
 * directory, no API call, no output — until the pipe closed 25 s later, then
 * completed in 7 s. A prompt in argv is an explicit instruction and must not
 * wait on a stream that may never close.
 *
 * Piping a task packet still works exactly as before: with no arguments,
 * blocking until EOF is the correct thing to do, because there is nothing
 * else to run.
 */
export async function resolvePrompt(
  argv: readonly string[],
  readStdinFn: () => Promise<string | undefined> = readStdin,
  command = "glm-worker",
): Promise<string> {
  const argText = argv.join(" ").trim();
  if (argText.length > 0) {
    return argText;
  }
  const stdinText = await readStdinFn();
  if (stdinText !== undefined && stdinText.trim().length > 0) {
    return stdinText;
  }
  throw Errors.promptRequired(command);
}
