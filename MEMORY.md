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
| Claude detection works | ⚠ `locateClaude()` implemented — no test exercises the discovery order itself |
| Codex detection works | ⚠ `locateCodex()` implemented — same gap as above |
| Interactive GLM works (`glm-chat`) | ⚠ implemented, unit-level only — never run against a real `claude.exe` |
| Worker GLM works | ✓ implemented + integration-tested |
| Read-only GLM works | ✓ implemented + tested (tool surface restricted to `Read,Glob,Grep`) |
| stdin works | ✓ tested (stdin → args → error priority) |
| `project init` idempotent | ✓ tested (second run is a no-op) |
| `project remove` safe | ✓ tested (preserves user content, deletes only router-owned empties) |
| `doctor` works | ⚠ implemented — no test coverage |
| `status` works | ⚠ implemented — no test coverage |
| `uninstall` works | ⚠ implemented — no test coverage |
| Secrets never logged | ✓ tested (`redact()`) |
| Unit tests pass | ✓ 68/68, 6 files (confirmed 2026-09-17) |
| Integration tests pass | ✓ same run, fake-agent based |
| README complete | ✓ covers every §52 section |

**Known gaps** (not blocking, but real before calling v0.1 done beyond "code complete"):
- No test drives `locateClaude`/`locateCodex` through their actual discovery order
  (`where.exe` → PATH search → config override → error) — only exercised indirectly.
- No command-level test for `doctor`, `status`, `init` (wizard), `uninstall`, `key`, `config` —
  only the primitives underneath them are tested.
- §50 acceptance criteria (fresh Windows machine, real `claude.exe`, real Z.ai key, end-to-end
  `glm-chat`/`glm-worker`/`glm-review`) has not been run.
- §49 Windows test matrix (Win10 vs 11, PowerShell 5.1 vs 7.x, Orca embedded terminal) unverified.
- Not yet published to npm.

## Decisions made outside the spec

| Date | Decision | Why |
|---|---|---|
| 2026-09-17 | Set `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` in the child env (`src/core/env.ts`) | GLM models aren't in Claude Code's model catalog, so it was enforcing an incorrect 200k context window on them |

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
