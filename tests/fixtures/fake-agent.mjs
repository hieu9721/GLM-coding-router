/**
 * Fake agent executable (spec §47 integration tests).
 * Dumps {args, env, cwd} as JSON to the file in GLM_TEST_OUTPUT,
 * then exits with GLM_TEST_EXIT (default 0).
 */
import fs from "node:fs";

const output = process.env.GLM_TEST_OUTPUT;
if (output) {
  const dump = {
    argv: process.argv.slice(2),
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
    },
    cwd: process.cwd(),
  };
  fs.writeFileSync(output, JSON.stringify(dump, null, 2), "utf8");
}
process.exit(Number(process.env.GLM_TEST_EXIT ?? 0));
