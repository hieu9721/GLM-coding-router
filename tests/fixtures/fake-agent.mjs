/**
 * Fake agent executable (spec §47 integration tests).
 * Dumps {args, env, cwd} as JSON to the file in GLM_TEST_OUTPUT, echoes
 * GLM_TEST_RESULT to stdout (claude-style result JSON for benchmark), then
 * exits with GLM_TEST_EXIT (default 0).
 */
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Writes are tracked so emitTestStream can prove the bytes reached the OS pipe
// before process.exit — pipe writes are asynchronous on Windows.
const pendingWrites = [];

function writeOut(data) {
  pendingWrites.push(new Promise((resolve) => process.stdout.write(data, () => resolve())));
}

function writeErr(data) {
  pendingWrites.push(new Promise((resolve) => process.stderr.write(data, () => resolve())));
}

// v2 spec Phase D: GLM_TEST_STREAM (NDJSON file whose non-empty lines go to
// stdout), GLM_TEST_STREAM_DELAY_MS (wait between lines, default 0),
// GLM_TEST_SPLIT=1 (write 7-byte chunks that cut lines mid-JSON, proving the
// parent's line splitting against a real pipe), GLM_TEST_STDERR ("\n"-separated
// lines to stderr). When none are set this emits nothing at all.
async function emitTestStream() {
  const streamFile = process.env.GLM_TEST_STREAM;
  const stderrText = process.env.GLM_TEST_STDERR;
  if (!streamFile && !stderrText) return;
  const delayMs = Number(process.env.GLM_TEST_STREAM_DELAY_MS ?? 0);
  if (streamFile) {
    const lines = fs
      .readFileSync(streamFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    if (process.env.GLM_TEST_SPLIT === "1") {
      const bytes = Buffer.from(lines.map((line) => line + "\n").join(""), "utf8");
      for (let offset = 0; offset < bytes.length; offset += 7) {
        const chunk = bytes.subarray(offset, offset + 7);
        writeOut(chunk);
        // One pause per line, not per chunk — a 7-byte sleep would make a
        // 52-line replay take a minute.
        if (delayMs > 0 && chunk.includes(0x0a)) await sleep(delayMs);
      }
    } else {
      for (const line of lines) {
        writeOut(line + "\n");
        if (delayMs > 0) await sleep(delayMs);
      }
    }
  }
  if (stderrText) {
    for (const line of stderrText.split("\n")) {
      if (line.length > 0) writeErr(line + "\n");
    }
  }
  await Promise.all(pendingWrites);
}

const output = process.env.GLM_TEST_OUTPUT;
if (output) {
  const dump = {
    argv: process.argv.slice(2),
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
    },
    cwd: process.cwd(),
  };
  fs.writeFileSync(output, JSON.stringify(dump, null, 2), "utf8");
}
if (process.env.GLM_TEST_RESULT) {
  process.stdout.write(process.env.GLM_TEST_RESULT);
}
await emitTestStream();
process.exit(Number(process.env.GLM_TEST_EXIT ?? 0));
