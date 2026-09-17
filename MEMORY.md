# MEMORY.md

Shared working state for whoever picks up this repo next (Claude Code, Codex, or a human) —
read it before starting a task, update it briefly after finishing one. Full rules live in
`AGENTS.md` / `CLAUDE.md`; technical detail lives in
`GLM Coding Router — Technical Specification v0.1.md`. This file only holds what isn't already
there: current status, decisions made *outside* the spec, and constraints discovered while
building. Keep it under ~150 lines — if it grows past that, split older entries into
`memory/YYYY-MM.md` and leave a one-line pointer here.

## Current status

Checked against the spec's Definition of Done (§51) on 2026-09-17 — code read + `npm run build` /
`npm test` / `npm run lint` actually run, not just "file exists":

| Item (§51) | Status |
|---|---|
| Package installs globally | ⚠ bin config correct, build clean — not yet published, never installed on a fresh machine |
| Four CLI binaries work | ✓ implemented, exercised via `tests/fixtures/fake-agent.mjs` |
| ZAI key setup works | ✓ `key set`/`key check` implemented; resolution logic unit-tested, command itself isn't |
| Stale Orca environment handled | ✓ `resolveZaiApiKey()` unit-tested (process env → Windows User Env → fail) |
| Claude detection works | ✓ `locateClaude()` — discovery order (where.exe → PATH → override → error) unit-tested with an isolated PATH (`tests/unit/claude-discovery.test.ts`) |
| Codex detection works | ✓ `locateCodex()`/`codexRequired()` — same test file, same isolation technique |
| Interactive GLM works (`glm-chat`) | ⚠ implemented, unit-level only — never run against a real `claude.exe` |
| Worker GLM works | ✓ implemented + integration-tested |
| Read-only GLM works | ✓ implemented + tested (tool surface restricted to `Read,Glob,Grep`) |
| stdin works | ✓ tested (stdin → args → error priority) |
| `project init` idempotent | ✓ tested (second run is a no-op) |
| `project remove` safe | ✓ tested (preserves user content, deletes only router-owned empties) |
| `doctor` works | ⚠ its Agents/Z.ai key logic is tested in isolation (`tests/integration/doctor.test.ts`); the command's own text/JSON rendering and the System/Commands/Codex-skill sections aren't |
| `status` works | ✓ tested end to end, both JSON and text output (`tests/integration/status.test.ts`) |
| `uninstall` works | ⚠ implemented — no test coverage |
| Secrets never logged | ✓ tested (`redact()`); `status` also asserted to never print the key value |
| Unit tests pass | ✓ 89/89, 9 files (confirmed 2026-09-17) |
| Integration tests pass | ✓ same run, fake-agent based |
| README complete | ✓ covers every §52 section |

**Known gaps** (not blocking, but real before calling v0.1 done beyond "code complete"):
- No command-level test for `init` (wizard), `uninstall`, `key set`, `config show`/`set` — only
  the primitives underneath them are tested. `init`/`key set`/`uninstall` use the `prompts`
  library interactively, which needs its own injection point before it's testable the same way
  as `doctor`/`status` (plain env/home injection, no interactive input).
- §50 acceptance criteria (fresh Windows machine, real `claude.exe`, real Z.ai key, end-to-end
  `glm-chat`/`glm-worker`/`glm-review`) has not been run.
- §49 Windows test matrix (Win10 vs 11, PowerShell 5.1 vs 7.x, Orca embedded terminal) unverified.
- Not yet published to npm.

## Decisions made outside the spec

| Date | Decision | Why |
|---|---|---|
| 2026-09-17 | Set `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` in the child env (`src/core/env.ts`) | GLM models aren't in Claude Code's model catalog, so it was enforcing an incorrect 200k context window on them |
| 2026-09-17 | `locateClaude`/`locateCodex`/`codexRequired` now take an optional trailing `env` param (default `process.env`), threaded into `where.exe`/`which` and `searchPathFor` | Lets tests fully replace `PATH` to isolate discovery from whatever is actually installed on the machine running the tests, without mocking modules — matches the project's existing "real fs/temp-dir, no `vi.mock`" test style |
| 2026-09-17 | `runDoctorChecks()` now also takes optional `env` and `readUserEnv`, threaded into `locateClaude`/`locateCodex`/`resolveZaiApiKey` and the process-key check | Same reasoning as above, applied to `doctor` — it was the only remaining caller of these primitives still hardcoded to the real environment |
| 2026-09-17 | `statusCommand()` takes a second `deps: {home, env, readUserEnv}` param (default `{}`, unchanged production behavior) | Same technique again; `status` was the last read-only command still hardcoded to `os.homedir()`/`process.env` |

## Constraints discovered

- Orca terminals snapshot the environment at startup — a key added after Orca starts is
  invisible to those terminals, hence the Windows-User-Environment fallback in
  `resolveZaiApiKey()` (`src/core/zai-key.ts`) is read on every invocation, never cached.
- Standalone Claude Code installs expose `claude.exe`, not a `.cmd` shim — don't assume the
  shim exists when locating the binary (`src/core/claude.ts`).

## Session log

| Date | What | Commits |
|---|---|---|
| 2026-09-17 | Scaffolded and implemented the full v0.1 CLI (core runtime, commands, tests, docs) | `ef60a43`..`ede6919` |
| 2026-09-17 | Loaded the spec's Definition of Done (§51) against actual code + a real build/test/lint run; recorded gap list above | — |
| 2026-09-17 | Closed the `locateClaude`/`locateCodex` discovery-order test gap: refactored for env injection, added `tests/unit/claude-discovery.test.ts` (12 tests) | `a274def`.. |
| 2026-09-17 | Extended the same env-injection technique to `doctor`; added `tests/integration/doctor.test.ts` (5 tests) covering Agents + Z.ai key logic | — |
| 2026-09-17 | Extended it again to `status`; added `tests/integration/status.test.ts` (4 tests, JSON + text output, secret-never-printed) | — |
