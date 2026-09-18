# Spec: benchmark (v0.4, spec §54)

## Problem

There is no way to measure how the Claude Code + GLM stack actually performs on
coding tasks — model choice, maxTurns, and prompts are tuned blind. Spec §54
(v0.4) asks for `glm-router benchmark` reporting duration, GLM calls, retry
count, tests, success, and manual intervention, comparing stacks.

## Approach

One new subcommand; the run path reuses the glm-worker machinery unchanged
(same claude discovery, key resolution, env injection, tool surface) plus one
addition — `--output-format json` — so the child's result document can be
parsed for turn/token metrics:

```
glm-router benchmark [--task <id>]... [--stack claude] [--max-turns <n>] [--repeat <n>]
```

- **Stacks**: v0.4.0 ships `claude` (Claude Code + GLM). `--stack codex` is
  recognized but fails with `ERROR [2]` explaining that headless Codex
  orchestration is not drivable yet — the harness is stack-shaped so a codex
  stack slots in without redesign. Unknown stacks → `ERROR [2]`.
- **Built-in task suite** (`src/templates/benchmark-tasks.ts`): each task has
  `id`, `files` (path → content written into a fresh temp dir), `prompt`, and a
  `validate` argv run after the worker. Two quota-small tasks: `fn-reverse`
  (implement a function until `node test.js` passes) and `fix-bug` (repair an
  off-by-one until the test passes). `--task <id>` repeatable; default: all.
  Unknown task id → `ERROR [2]` listing ids.
- **Per run**: fresh temp dir (no git needed — isolation by directory) → write
  files → spawn claude with glm-worker args + `--output-format json`,
  stdout/stderr **captured** (not inherited) → parse the result JSON
  defensively (`num_turns`, `usage` tokens, `subtype`, `is_error`) → run the
  validate command with the parent env → record metrics → remove the temp dir.
- **Metric mapping (§54)**:
  - `duration` — our wall clock in ms (claude's `duration_ms` also recorded
    when present);
  - `GLM calls` — `num_turns` (assistant turns ≈ GLM round-trips), `"-"` when
    the child does not report it;
  - `retry count` — not exposed by Claude Code today → `"-"` (a local counting
    proxy is future work, deliberately out of scope);
  - `tests` — validate exit code (PASS/FAIL + output tail on failure);
  - `success` — worker exit 0 ∧ `is_error` false ∧ tests PASS;
  - `intervention` — `"none (headless)"` when the run self-completed,
    `"needed"` when it did not (non-zero exit, `is_error`, or error subtype
    such as `error_max_turns`).
- **Report**: text table per task; `--json` emits the full metrics object;
  the same JSON is always saved to
  `%USERPROFILE%\.glm-coding-router\benchmarks\benchmark-<timestamp>.json`
  and the path is printed (history for later cross-run comparison).
- **Quota guard**: interactive runs get a confirm prompt (benchmark makes real
  GLM API calls); non-interactive without `--yes` fails `ERROR [2]`.
- **Exit semantics**: failed tasks are *measurements*, not CLI errors — the
  command exits 0 once the suite ran. Infrastructure failures use the usual
  codes: key 10, config 11, claude 20, invalid task/stack/`--yes` 2, spawn
  failure 40.
- `spawnAgent`'s core is factored so a new `spawnAgentCapture` (piped
  stdio, same SIGINT/SIGTERM forwarding, resolves `{code, stdout, stderr}`)
  shares it; existing callers unchanged.
- The fake-agent fixture learns `GLM_TEST_RESULT`: echo that string to stdout
  before exiting, so tests drive the result-JSON parser through a real spawn.

Out of scope: codex stack, retry-count proxy, parallel workers, cross-run
trend analysis, custom task files.

## Scope

- `src/core/process.ts`: shared spawn core + `spawnAgentCapture`.
- `src/templates/benchmark-tasks.ts` (new): the built-in suite.
- `src/commands/benchmark.ts` (new): `benchmarkCommand(options, deps)` with
  injectable `deps` (`home`, `env`, `readUserEnv`, `confirm`, `spawn`,
  `now`, `mkdtemp`) — repo-standard DI, no `vi.mock`.
- `src/cli.ts`: `benchmark` command wiring.
- `tests/fixtures/fake-agent.mjs`: `GLM_TEST_RESULT` echo.
- Tests: `tests/unit/benchmark-tasks.test.ts`, `tests/integration/benchmark-command.test.ts`.
- Docs: README benchmark section, AGENTS.md structure lines, MEMORY.md,
  version → 0.4.0.

## Acceptance criteria

- [ ] `benchmark --yes --task fn-reverse` runs the task in a temp dir, spawns
      the worker with glm-worker args + `--output-format json` and the GLM env,
      runs `node test.js`, prints the metric table, saves the report JSON under
      the config dir, and exits 0; temp dir removed.
- [ ] Metrics map per the table above; retry renders `"-"`; failed validation
      renders FAIL with the tail; success false does not fail the command.
- [ ] `--json` output is valid JSON and never contains the key value; the
      saved report path is printed.
- [ ] `--dry-run` lists selected tasks/stack and spawns nothing, writes nothing.
- [ ] Non-interactive without `--yes` → `ERROR [2]`; unknown task/stack →
      `ERROR [2]` listing valid ids; missing key/claude → 10/20.
- [ ] `spawnAgentCapture` is covered through the fake agent (result JSON
      echoed via `GLM_TEST_RESULT`, exit code via `GLM_TEST_EXIT`).
- [ ] `npm run build`, `npm test`, `npm run lint` green.

## Validation

```
npm run build && npm test && npm run lint
npx vitest run tests/unit/benchmark-tasks.test.ts tests/integration/benchmark-command.test.ts
# real run (needs key + claude): glm-router benchmark --yes --task fn-reverse
```
