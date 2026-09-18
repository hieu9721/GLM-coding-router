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
| Package installs globally | ✓ `0.1.1`/`0.2.0`/`0.3.0` published to npm (user runs the 2FA-gated publish manually; latest = 0.3.0, tags v0.1.1/v0.2.0/v0.3.0 pushed to GitHub). All verified from the registry: installed into clean temp prefixes → binaries incl. `glm-fast` work, `glm-worker` returned `REGISTRY_OK`/`V02_OK`; 0.3.0's `delegate` ran a real GLM worker returning `REGISTRY_V03_OK` with worktree+branch kept, and the ERROR [31]/ERROR [2] paths fired correctly from the registry shims; machine's own global install tracks the registry (now 0.3.0). Fresh-machine install (§50) remains blocked on hardware |
| Four CLI binaries work | ✓ implemented, exercised via `tests/fixtures/fake-agent.mjs` |
| ZAI key setup works | ✓ `key set`/`key check`/`key remove` tested end to end (`tests/integration/key-command.test.ts`) via injected `prompt`/`setEnv`/`deleteEnv` — real key set once manually via `glm-router key set` earlier in the project's life, real machine confirms `doctor`/`status` see it |
| Stale Orca environment handled | ✓ `resolveZaiApiKey()` unit-tested (process env → Windows User Env → fail) |
| Claude detection works | ✓ `locateClaude()` — discovery order (where.exe → PATH → override → error) unit-tested with an isolated PATH (`tests/unit/claude-discovery.test.ts`) |
| Codex detection works | ✓ `locateCodex()`/`codexRequired()` — same test file, same isolation technique |
| Interactive GLM works (`glm-chat`) | ✓ unit-tested; `glm-chat --version` run live from the fresh-prefix install — printed `2.1.274 (Claude Code)`, confirming the interactive spawn path (2026-09-17) |
| Worker GLM works | ✓ integration-tested, **and run for real**: `glm-worker "Reply exactly with WORKER_OK"` on this machine returned exactly `WORKER_OK`, exit 0 (2026-09-17) |
| Read-only GLM works | ✓ integration-tested, **and run for real**: asked `glm-review` to create a file — it reported it has no Write/Edit/Bash tool available and the file was confirmed absent afterward (2026-09-17) |
| stdin works | ✓ tested (stdin → args → error priority) |
| `project init` idempotent | ✓ tested (second run is a no-op) |
| `project remove` safe | ✓ tested (preserves user content, deletes only router-owned empties) |
| `doctor` works | ✓ Agents/Z.ai key logic isolation-tested; **and run for real** — `glm-router doctor` and `glm-router doctor --network` both report HEALTHY with the real Z.ai endpoint reachable (2026-09-17). Text/JSON rendering and the `--network` probe (spec §42) now covered end to end via injected `fetchImpl` (`tests/integration/doctor-command.test.ts`) |
| `status` works | ✓ tested end to end (JSON + text), **and run for real** — `glm-router status` matches the real machine's state |
| `uninstall` works | ✓ tested end to end (`tests/integration/uninstall-command.test.ts`) — config removal, key-kept-by-default, and managed-block stripping via `deps.root`; the interactive "remove key" wizard path is untestable without mutating real stdin, documented as skipped in the test file |
| Secrets never logged | ✓ tested (`redact()`); `status` also asserted to never print the key value |
| Unit tests pass | ✓ 114/114, 15 files (confirmed 2026-09-17) |
| Integration tests pass | ✓ same run, fake-agent based |
| README complete | ✓ covers every §52 section |

**Known gaps — all remaining items are BLOCKED on hardware** (no code work pending):

- **[BLOCKED — needs a fresh Windows machine]** §50 acceptance criteria: everything verified on
  *this* machine (2026-09-17) — `doctor`/`doctor --network`/`status` HEALTHY with the real
  endpoint reachable, `glm-worker` returned `WORKER_OK` (and later `REGISTRY_OK`/`V02_OK` from
  registry installs), `glm-review` confirmed it has no write-capable tool and created nothing,
  `project init --dry-run` reports "already up to date" on installed blocks without touching
  files. Registry installs of 0.1.1 and 0.2.0 verified into clean prefixes, incl. the
  simulated-fresh-machine pass (no claude/codex/git states, fake home). Still open: run the same
  suite on an actual **fresh** Windows machine via `npm install -g glm-coding-router`.
- **[BLOCKED — needs Win10 hardware + Orca terminal]** §49 Windows test matrix: PowerShell axis
  verified as far as this machine allows — the code always spawns `powershell.exe` (5.1) for key
  resolution regardless of parent shell, and `glm-router key check` was run from a PowerShell 7.6
  parent successfully. Still open: real Win10 machine, Orca embedded terminal.

When the hardware is available: for §50, follow the checks listed above on the fresh machine
(MEMORY.md carries the full context); for §49, repeat the key checks under PS 5.1/7.x on Win10
and run `glm-worker` inside an Orca embedded terminal.

## Decisions made outside the spec

| Date | Decision | Why |
|---|---|---|
| 2026-09-17 | Set `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` in the child env (`src/core/env.ts`) | GLM models aren't in Claude Code's model catalog, so it was enforcing an incorrect 200k context window on them |
| 2026-09-17 | `locateClaude`/`locateCodex`/`codexRequired` now take an optional trailing `env` param (default `process.env`), threaded into `where.exe`/`which` and `searchPathFor` | Lets tests fully replace `PATH` to isolate discovery from whatever is actually installed on the machine running the tests, without mocking modules — matches the project's existing "real fs/temp-dir, no `vi.mock`" test style |
| 2026-09-17 | `runDoctorChecks()` now also takes optional `env` and `readUserEnv`, threaded into `locateClaude`/`locateCodex`/`resolveZaiApiKey` and the process-key check | Same reasoning as above, applied to `doctor` — it was the only remaining caller of these primitives still hardcoded to the real environment |
| 2026-09-17 | `statusCommand()` takes a second `deps: {home, env, readUserEnv}` param (default `{}`, unchanged production behavior) | Same technique again; `status` was the last read-only command still hardcoded to `os.homedir()`/`process.env` |
| 2026-09-17 | `key.ts`/`init.ts`/`uninstall.ts` also take injectable `deps` (`prompt`, `setEnv`, `deleteEnv`, `home`, `root`, `env`) and no longer call `process.exit()` internally — `askChoices()` in both `init.ts` and `uninstall.ts` returns a `{kind: "ok"\|"non-interactive"\|"cancelled"}` union instead | `process.exit()` inside a function makes it untestable (kills the test runner); the exit-code decision now belongs to the caller (`initCommand`/`uninstallCommand`), which is how every other command already worked |
| 2026-09-17 | This refactor + all 4 new command test files were delegated to `glm-worker` per this repo's own delegation policy, in 6 dispatches (2 full-scope attempts that hit `--max-turns` and were abandoned, then split one-file-at-a-time after bumping `worker.maxTurns` to 40) | The first two attempts tried to do all 4 files' tests in one call and ran out of turns before writing anything; splitting by file fit the budget. Every dispatch's diff was read and `npm run build`/`test`/`lint` re-run manually before accepting — the worker itself could not run these (Bash was declined in its headless sandbox) |
| 2026-09-17 | `doctorCommand()` now takes a second `deps: {home, env, readUserEnv, fetchImpl}` param (default `{}`, unchanged production behavior); `probeEndpoint()` takes an injectable `fetchImpl` param | Closed the last doctor test gap noted above — same DI technique as `statusCommand`. Found and fixed a real bug while doing it: `doctor --network --json` never ran the network probe at all (JSON branch returned before computing `networkResult`); JSON output now includes a `network` field when `--network` is passed |
| 2026-09-17 | v0.2: our `--profile` flag is consumed by the four task binaries and intentionally shadows Claude Code's own `--profile` inside them; unknown profiles reuse `Errors.configInvalid` (exit 11) rather than a new code | Keeps one config-error family; claude users needing claude's profile flag must call `claude` directly. Design details in `specs/glm-fast-profiles.md` |
| 2026-09-18 | v0.3 delegate: worktrees live **outside** the repo at `<repo>.glm-worktrees/<name>`; worktree + branch are **kept** after every run; `--remove` fires only after success via plain `git worktree remove` (git's dirty-tree refusal is the data-loss guard); when `--profile` is absent, a profile literally named `<name>` applies implicitly; delegate error names reuse §35 families — `GIT_NOT_FOUND`/`GIT_REPO_REQUIRED` → 30, `WORKTREE_FAILED` → 31, `INVALID_DELEGATE_NAME` → 2 | Sibling-dir placement means no `.gitignore` edits ever; keep-by-default honors the no-automatic-git-commits rule (the only branch deletion is rolling back the branch this same invocation created, when the worker never spawned). Design in `specs/delegate-worktrees.md` |

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
| 2026-09-17 | Delegated the `init`/`uninstall`/`key`/`config` DI refactor + 4 new test files to `glm-worker` (6 dispatches, see decision above); reviewed every diff and re-ran build/test/lint myself before accepting each one. Also ran real acceptance checks with the actually-installed `glm-router` on this machine (`doctor`, `doctor --network`, `status`, `glm-worker`, `glm-review`, `project init --dry-run`) — all matched spec. 101 tests, 13 files, all green | `01dc8c4` |
| 2026-09-17 | Closed the last doctor test gap (spec §42 network probe + JSON/text rendering): added DI to `doctorCommand`/`probeEndpoint`, wrote `tests/integration/doctor-command.test.ts` (10 tests), fixed a real bug where `--network --json` skipped the probe entirely. 111 tests, 14 files, all green; build/lint clean | `41f45b9` |
| 2026-09-17 | Fresh-install simulation: `npm pack` → installed the tarball into a clean temp global prefix → all four binaries verified from the fresh shims (`doctor` HEALTHY, `glm-chat --version`, `glm-worker "WORKER_OK"`); closes the local half of §50's install criterion. Fixed the dry-run nit: `projectInitCommand` now takes `{root, home}` deps and reports "already up to date" when the managed block is unchanged (`tests/integration/project-init-command.test.ts`, 3 tests). Refreshed the machine's global `glm-router` via `npm install -g .` so live checks use current code. 114 tests, 15 files, all green | `f214f5f` |
| 2026-09-17 | Discovered registry 0.1.0 (user-published 10:13Z) is a stale build missing the last 5 commits incl. the `doctor --network --json` bug fix. Bumped to 0.1.1 and attempted publish — blocked by account 2FA (EOTP); user will publish manually | `debec0a` |
| 2026-09-17 | User published 0.1.1 (14:43Z, latest). Verified from the registry into a clean prefix: `doctor` HEALTHY, dry-run fix present, `glm-worker` → `REGISTRY_OK`; switched this machine's global install to the registry version. v0.1 is now published; remaining: fresh-machine §50 run and §49 matrix | — |
| 2026-09-17 | Ran a "simulated fresh machine" pass with the real registry binary (`.cmd` shims, fake `USERPROFILE`, PATH stripped of claude/codex/git): status reports both agents missing (exit 0); `doctor` → FAIL claude / WARN codex+git, config defaults, exit 1; `glm-worker` → `ERROR [CLAUDE_NOT_FOUND]` exit 20 with actionable hint; `project init`→idempotent→`project remove` lifecycle in a fresh git repo writes ownership to the fake home only; non-git dir falls back to cwd; `config show`/`set` write to the fake home. Real home verified unpolluted. One state not simulatable without deleting the real Windows User Env key: "no key anywhere" (covered by unit tests only) | — |
| 2026-09-17 | Pushed main + tag `v0.1.1` to GitHub on user request; closed the PowerShell axis of §49 (key resolution always spawns `powershell.exe` 5.1 regardless of parent shell; `key check` verified from a PS 7.6 parent) | `533ed3a` |
| 2026-09-17 | **v0.2 implemented** per spec §54: new `glm-fast` interactive binary (all model slots pinned to `models.fast`), `--profile <name>` on all four task binaries, `profiles` map in config schema. Spec written first: `specs/glm-fast-profiles.md`. 18 new tests (`tests/unit/profile.test.ts`, `tests/integration/glm-fast.test.ts`, fake-agent now dumps all three model slots); live-verified `glm-fast --version` and the unknown-profile `ERROR [11]` path. 132 tests, 17 files, all green. Version bumped to 0.2.0 | `3234816` |
| 2026-09-17 | User published 0.2.0 to npm; verified from the registry into a clean prefix (shims incl. glm-fast, `glm-fast --version` spawn, unknown-profile ERROR, `glm-worker` → `V02_OK`) and upgraded this machine's global install to the registry version. GitHub main is in sync | — |
| 2026-09-17 | Pushed tag `v0.2.0`. Marked §49/§50 as BLOCKED-on-hardware in Known gaps — no code work pending; when a fresh Windows machine / Orca terminal is available, the MEMORY gap entries list exactly what to run | — |
| 2026-09-18 | **v0.3 implemented** per spec §54: `glm-router delegate <name>` runs a glm-worker in an isolated git worktree (branch `glm/delegate/<name>`, worktree at `<repo>.glm-worktrees/<name>` outside the repo, cut from HEAD). Spec written first: `specs/delegate-worktrees.md`. New `src/core/git.ts` + `src/core/worktree.ts` + `src/commands/delegate.ts`; 28 new tests (`tests/unit/worktree.test.ts`, `tests/integration/delegate-command.test.ts` with real git in temp repos + injected-spawn DI, incl. a real fake-agent spawn inside a created worktree). 160 tests, 19 files, all green. Version bumped to 0.3.0; publish pending user (2FA) | `bb6d44a` |
| 2026-09-18 | User published 0.3.0 to npm (latest). Verified from the registry into a clean prefix: `glm-router --version` → 0.3.0, `status`/`delegate --help` correct; real `delegate registry-smoke` in a temp git repo returned `REGISTRY_V03_OK` (exit 0, worktree + branch kept at the documented paths); same-name rerun → `ERROR [31] WORKTREE_FAILED`, bad name → `ERROR [2] INVALID_DELEGATE_NAME` from the registry shims. Upgraded this machine's global install to the registry 0.3.0. GitHub main + tag `v0.3.0` already in sync | — |
