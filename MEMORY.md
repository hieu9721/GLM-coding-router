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
| ZAI key setup works | ✓ `key set`/`key check`/`key remove` tested end to end (`tests/integration/key-command.test.ts`) via injected `prompt`/`setEnv`/`deleteEnv` — real key set once manually via `glm-router key set` earlier in the project's life, real machine confirms `doctor`/`status` see it |
| Stale Orca environment handled | ✓ `resolveZaiApiKey()` unit-tested (process env → Windows User Env → fail) |
| Claude detection works | ✓ `locateClaude()` — discovery order (where.exe → PATH → override → error) unit-tested with an isolated PATH (`tests/unit/claude-discovery.test.ts`) |
| Codex detection works | ✓ `locateCodex()`/`codexRequired()` — same test file, same isolation technique |
| Interactive GLM works (`glm-chat`) | ⚠ unit-tested; `glm-chat --version` not separately re-verified live this session, but `glm-worker`/`glm-review` (same underlying spawn path) were — see below |
| Worker GLM works | ✓ integration-tested, **and run for real**: `glm-worker "Reply exactly with WORKER_OK"` on this machine returned exactly `WORKER_OK`, exit 0 (2026-09-17) |
| Read-only GLM works | ✓ integration-tested, **and run for real**: asked `glm-review` to create a file — it reported it has no Write/Edit/Bash tool available and the file was confirmed absent afterward (2026-09-17) |
| stdin works | ✓ tested (stdin → args → error priority) |
| `project init` idempotent | ✓ tested (second run is a no-op) |
| `project remove` safe | ✓ tested (preserves user content, deletes only router-owned empties) |
| `doctor` works | ✓ Agents/Z.ai key logic isolation-tested; **and run for real** — `glm-router doctor` and `glm-router doctor --network` both report HEALTHY with the real Z.ai endpoint reachable (2026-09-17). Text/JSON rendering itself still has no dedicated unit test |
| `status` works | ✓ tested end to end (JSON + text), **and run for real** — `glm-router status` matches the real machine's state |
| `uninstall` works | ✓ tested end to end (`tests/integration/uninstall-command.test.ts`) — config removal, key-kept-by-default, and managed-block stripping via `deps.root`; the interactive "remove key" wizard path is untestable without mutating real stdin, documented as skipped in the test file |
| Secrets never logged | ✓ tested (`redact()`); `status` also asserted to never print the key value |
| Unit tests pass | ✓ 101/101, 13 files (confirmed 2026-09-17) |
| Integration tests pass | ✓ same run, fake-agent based |
| README complete | ✓ covers every §52 section |

**Known gaps** (not blocking, but real before calling v0.1 done beyond "code complete"):
- §50 acceptance criteria: run for real on *this* machine (not a fresh one) on 2026-09-17 —
  `doctor`/`doctor --network`/`status` HEALTHY with the real endpoint reachable, `glm-worker`
  returned `WORKER_OK`, `glm-review` confirmed it has no write-capable tool and created nothing,
  `project init --dry-run` reported the (already-installed) managed blocks without touching the
  files (verified via checksum before/after). Not yet run on an actual **fresh** Windows machine
  with a fresh `npm install -g` — that part of §50 is still open.
- Minor UX nit found while doing the above: `project init --dry-run`'s diff always renders a
  full remove+reinsert of the managed block even when the content is byte-identical (confirmed
  via checksum — the real file is untouched, this is only a cosmetic "would update" wording
  issue in the diff renderer, not a correctness bug). Not fixed; low priority.
- §49 Windows test matrix (Win10 vs 11, PowerShell 5.1 vs 7.x, Orca embedded terminal) unverified.
- Not yet published to npm.

## Decisions made outside the spec

| Date | Decision | Why |
|---|---|---|
| 2026-09-17 | Set `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` in the child env (`src/core/env.ts`) | GLM models aren't in Claude Code's model catalog, so it was enforcing an incorrect 200k context window on them |
| 2026-09-17 | `locateClaude`/`locateCodex`/`codexRequired` now take an optional trailing `env` param (default `process.env`), threaded into `where.exe`/`which` and `searchPathFor` | Lets tests fully replace `PATH` to isolate discovery from whatever is actually installed on the machine running the tests, without mocking modules — matches the project's existing "real fs/temp-dir, no `vi.mock`" test style |
| 2026-09-17 | `runDoctorChecks()` now also takes optional `env` and `readUserEnv`, threaded into `locateClaude`/`locateCodex`/`resolveZaiApiKey` and the process-key check | Same reasoning as above, applied to `doctor` — it was the only remaining caller of these primitives still hardcoded to the real environment |
| 2026-09-17 | `statusCommand()` takes a second `deps: {home, env, readUserEnv}` param (default `{}`, unchanged production behavior) | Same technique again; `status` was the last read-only command still hardcoded to `os.homedir()`/`process.env` |
| 2026-09-17 | `key.ts`/`init.ts`/`uninstall.ts` also take injectable `deps` (`prompt`, `setEnv`, `deleteEnv`, `home`, `root`, `env`) and no longer call `process.exit()` internally — `askChoices()` in both `init.ts` and `uninstall.ts` returns a `{kind: "ok"\|"non-interactive"\|"cancelled"}` union instead | `process.exit()` inside a function makes it untestable (kills the test runner); the exit-code decision now belongs to the caller (`initCommand`/`uninstallCommand`), which is how every other command already worked |
| 2026-09-17 | This refactor + all 4 new command test files were delegated to `glm-worker` per this repo's own delegation policy, in 6 dispatches (2 full-scope attempts that hit `--max-turns` and were abandoned, then split one-file-at-a-time after bumping `worker.maxTurns` to 40) | The first two attempts tried to do all 4 files' tests in one call and ran out of turns before writing anything; splitting by file fit the budget. Every dispatch's diff was read and `npm run build`/`test`/`lint` re-run manually before accepting — the worker itself could not run these (Bash was declined in its headless sandbox) |

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
| 2026-09-17 | Delegated the `init`/`uninstall`/`key`/`config` DI refactor + 4 new test files to `glm-worker` (6 dispatches, see decision above); reviewed every diff and re-ran build/test/lint myself before accepting each one. Also ran real acceptance checks with the actually-installed `glm-router` on this machine (`doctor`, `doctor --network`, `status`, `glm-worker`, `glm-review`, `project init --dry-run`) — all matched spec. 101 tests, 13 files, all green | pending |
