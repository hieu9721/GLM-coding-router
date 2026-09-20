# Spec: cross-platform support (Linux + macOS)

Closes the "Linux and macOS support is planned for v0.2" debt that has been sitting in
`Errors.unsupportedPlatform` since v0.1. Target version **1.1.0**, shipped **before** any v2
work (`specs/v2-architecture.md`), because the v2 build machine is a Linux box and the suite
is currently red there.

## Problem

Measured on this machine on 2026-09-20 — registry 1.0.0 installed into a clean prefix on
Ubuntu 24.04 (Node 22.22.1, claude 2.1.278, codex, git), fake HOME, no prior config:

**Already works on Linux, unchanged:** all six binaries install and run; `status` locates
claude and codex through `which`; `doctor --network` reaches the real Z.ai endpoint;
`project init` / `remove` / corrupt-marker guard; dual-agent `skill install` / `remove`;
the MCP server's full stdio handshake (4 frames from 6 input lines, stderr empty); the
`mcp` snippet path derivation; every `benchmark` and `delegate` error path. `locateClaude`
already branches to `which` and drops the `.exe` suffixes; `spawnAgent`, the managed-block
engine, `paths.ts`, config and the worktree code are platform-neutral as written.

**Genuinely Windows-bound — the whole of the debt:**

1. `readWindowsUserEnv` / `setWindowsUserEnv` / `deleteWindowsUserEnv` spawn `powershell.exe`.
2. `assertWindows()` in `key set` / `key remove` (`src/commands/key.ts:39,95`).
3. `doctor`'s platform check reports `✗ Platform linux` → the whole report is
   ISSUES DETECTED and exit 1 on a machine where everything else is fine.
4. `init.ts:122` skips key storage with "requires Windows in v0.1".
5. Windows-only strings in errors and messages: `%USERPROFILE%\…` (`config.ts:81`,
   `paths.ts:4`, `Errors.configInvalid`), `claude.exe` / `C:\path\to\claude.exe`
   (`Errors.claudeNotFound`), "Windows User Environment" (`doctor.ts:202`,
   `uninstall.ts:117`).
6. **A dead-end hint:** with no key, `glm-worker` exits 10 saying *"Run: glm-router key set"* —
   and on Linux that command exits 50 "requires Windows". The tool's own advice does not work.
7. **15 of 207 tests fail on Linux** (build and lint are clean): 6 are fixtures writing
   `claude.exe` / `codex.exe` / `.cmd` names that `searchPathFor` correctly ignores off
   Windows (`claude-discovery` ×5, `status` ×1); 5 hit the real `assertWindows()` gate
   (`key-command` ×3, `init-command` ×2); 4 assert `doctor` is HEALTHY, impossible while the
   platform check fails (`doctor-command` ×3, `doctor` ×1).

So the Windows-only stance is mostly a *claim*, not a constraint. One capability is really
missing — persistent key storage — plus a layer of Windows-shaped text.

## Approach

### Platform policy (say exactly what is verified)

| Platform | Status | Basis |
|---|---|---|
| `win32` | **supported** | verified live through v1.0's registry-verification ritual |
| `linux` | **supported** | verified on this machine, 2026-09-20 (list above) |
| `darwin` | **experimental** | designed here, **never executed** — no Mac available |
| anything else | unsupported | `Errors.unsupportedPlatform` stays, for these only |

macOS ships as "experimental" in README and `doctor` until someone runs the suite on a Mac.
Claiming verified support for a platform nobody has run is exactly the habit this repo has
avoided since v0.5 verified the quota endpoint before designing on it.

### Key storage: what replaces the Windows User Environment

The Windows design reads the key from an out-of-process store on **every** invocation, never
caching it, because Orca terminals snapshot a stale environment. The POSIX port keeps that
property where a store exists and is honest where it does not.

Evidence gathered before choosing (this machine): `gnome-keyring-daemon` **is** running with
the `secrets` component and `DBUS_SESSION_BUS_ADDRESS` is set, but **`secret-tool` is not
installed** (`libsecret-tools` is not a default package on Ubuntu 24.04). So on Linux the
keyring CLI is the *exception*, not the rule — a design that requires it would fail on the
first machine it was written for.

New `src/core/user-env.ts` dispatches behind the `readUserEnv` seam that
`resolveZaiApiKey({ readUserEnv })` already exposes, so nothing above it changes:

| Platform | Store | Mechanism |
|---|---|---|
| `win32` | Windows User Environment | the existing `powershell.exe` functions, moved, **byte-identical** |
| `darwin` | login keychain | `security add-generic-password -U -s glm-coding-router -a ZAI_API_KEY -w …` / `find-generic-password -w` / `delete-generic-password`. `security` is part of macOS, so it is always present |
| `linux` | libsecret, **only when `secret-tool` is on PATH** | `secret-tool store/lookup/clear --label=… service glm-coding-router account ZAI_API_KEY` |
| any, when no store | none | `readUserEnv` returns `undefined`; `key set` prints instructions (below) |

`resolveZaiApiKey`'s documented order is unchanged — `process.env` → user store → fail — and
the key is still never written to `config.json`, the repo, or any file this tool owns. The
value is passed to the child store through an environment variable, never interpolated into
a command string, exactly as `setWindowsUserEnv` already does.

**When there is no store** (the common Linux case, as measured), `key set` stops being an
error and becomes a guide: it prints the exact export line and names the profile file to put
it in (`~/.bashrc`, `~/.zshrc` or `~/.profile`, chosen from `$SHELL` and what exists), tells
the user the current shell needs re-sourcing, and exits **0** — it did the only useful thing
available. `key check` remains the verification step and keeps exiting 10 until the key is
actually resolvable. It never prints the key value.

### Platform-aware text (this is what closes the dead-end hint)

`Errors.zaiKeyMissing()` takes the platform into account: Windows keeps
`Run: glm-router key set`; elsewhere it prints `glm-router key set` **and** the export line,
so the advice works wherever it is read. Same treatment for `Errors.configInvalid` (config
path), `Errors.claudeNotFound` (binary name and the `config set claudePath` example), and
the "reloads from the Windows User Environment" notes in `doctor.ts:202` and
`uninstall.ts:117`, which name the store actually in use.

One helper, `describeKeyStore()`, is the single source of that per-platform wording, so the
next message added does not re-invent it.

### doctor

`windowsVersionName()` becomes `platformName()` (`Windows 11`, `Linux 6.x`, `macOS 15.x`).
The platform check is `ok` for the three supported platforms — `warn` with "experimental" on
`darwin` — and `fail` only for genuinely unsupported ones. The Z.ai key row names the store
that was actually consulted.

### Windows safety (the real risk in this change)

This work is authored on Linux with **no way to execute the Windows paths**. Mitigation is
structural, not optimistic: the PowerShell functions are *moved*, not rewritten, and the new
dispatcher selects them unchanged on `win32`; no existing Windows branch is edited. Every
Windows-behavior test keeps running via `it.runIf(isWindows())`, and the POSIX counterparts
are new tests, not edits of the old ones. **`npm test` on a Windows machine is a release gate
for 1.1.0** — the same ritual as every previous publish, and this spec is not "done" until it
has run there.

## Scope

- `src/core/platform.ts` — `platformName()`, `isSupportedPlatform()`, `platformSupport()`;
  `assertWindows()` kept only for genuinely Windows-only internals.
- `src/core/user-env.ts` (new) — the dispatcher and the three POSIX implementations.
- `src/core/zai-key.ts` — PowerShell functions move to `user-env.ts`; re-exported for
  compatibility; `resolveZaiApiKey` unchanged in behavior.
- `src/core/errors.ts` — platform-aware hints, `describeKeyStore()`.
- `src/commands/key.ts` — `assertWindows()` removed; no-store guidance path.
- `src/commands/init.ts` — the Windows-only key branch replaced by the same guidance.
- `src/commands/doctor.ts`, `src/commands/uninstall.ts` — platform-aware checks and text.
- `src/core/paths.ts`, `src/core/config.ts` — doc comments (no behavior).
- Tests: `tests/helpers/platform.ts` (`exeName()`), fixture fixes in `claude-discovery` and
  `status`; `it.runIf`/`skipIf` split in `key-command`, `init-command`, `doctor*`; new POSIX
  counterparts; `tests/unit/user-env.test.ts` with injected runners.
- Docs: README platform section, AGENTS.md ("v0.1 targets Windows 10/11 only" → the policy
  table), MEMORY.md, version → 1.1.0.

**Out of scope:** WSL as a distinct target (it is `linux`); a bundled keyring dependency;
migrating an existing Windows key into a keychain; Windows-specific installers; anything in
`specs/v2-architecture.md`.

## Acceptance criteria

- [ ] `npm test` is **green on Linux** — the 15 current failures resolved by fixing the 6
      fixtures and splitting the 9 platform-behavior tests, not by deleting coverage.
- [ ] `npm test` is **green on Windows** (release gate, run on the Windows machine).
- [ ] `glm-router doctor` on Linux reports HEALTHY and exits 0 when claude, git and the key
      are present; `darwin` renders the experimental warning; an unsupported platform still
      fails.
- [ ] No key on Linux → `ERROR [10]` whose hint contains a command that actually works
      (`export ZAI_API_KEY=…`), and `key set` exits 0 after printing that guidance.
- [ ] With `ZAI_API_KEY` exported on Linux: `glm-worker` completes a real task,
      `glm-review` refuses to write, `usage` renders the live quota, and the MCP
      `glm_worker` / `glm_usage` tools return real results.
- [ ] Where a store exists (`secret-tool` installed, or macOS): `key set` → `key check` →
      `key remove` round-trips without the key ever reaching disk in a file this tool owns.
- [ ] No output path prints the key value, on any platform.
- [ ] Windows behavior is unchanged: the PowerShell code is moved, not edited, and
      `git diff` on those functions shows only the file they live in.
- [ ] `npm run build`, `npm test`, `npm run lint` green; README, AGENTS.md, MEMORY.md
      updated; version 1.1.0.

## Validation

```
# On Linux (this machine)
npm run build && npm test && npm run lint     # must be fully green
glm-router doctor                              # HEALTHY, exit 0, once the key is exported
glm-router key set                             # prints the export line, exit 0
glm-worker "Reply exactly with LINUX_OK"       # needs ZAI_API_KEY exported

# On Windows (release gate, before publishing 1.1.0)
npm test
glm-router key check && glm-router doctor && glm-worker "Reply exactly with WIN_OK"

# Registry verification after publish — the standard ritual (MEMORY.md)
npm install -g --prefix <clean temp prefix> glm-coding-router@1.1.0
```
