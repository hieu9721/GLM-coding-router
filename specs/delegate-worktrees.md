# Spec: delegate — git worktree orchestration (v0.3, spec §54)

## Problem

`glm-worker` runs in the caller's checkout, so a second worker (or the orchestrating
Claude/Codex session) cannot touch the same files at the same time — parallel
implementation tasks trample each other's working tree. Spec §54 (v0.3) asks for
`glm-router delegate backend|frontend|tests`, each worker running in an isolated
git worktree.

## Approach

One new subcommand, no new binary and no changes to spawning/env/key resolution —
delegate composes the existing worker path with git worktree management:

```
glm-router delegate <name> [prompt...]
```

- `<name>` is a slug (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, exit 2 otherwise). It names
  the branch `glm/delegate/<name>` and the directory
  `<parent-of-repo-root>/<repo-name>.glm-worktrees/<name>` — **outside** the repo,
  so no `.gitignore` edits and no pollution of the main checkout's status.
- Prompt resolution is identical to glm-worker: stdin (non-TTY) → args →
  `PROMPT_REQUIRED`. `--profile <p>` is explicit; if not given and a profile
  literally named `<name>` exists, it is applied (the v0.2 roadmap pairs
  `delegate backend` with the `backend` profile). Unknown explicit profile →
  `ERROR [11]`.
- Flow: validate name → `git rev-parse --show-toplevel` (strict: no repo →
  `ERROR [30] GIT_REPO_REQUIRED`; git missing → `ERROR [30] GIT_NOT_FOUND`) →
  config/profile → key (10) → claude (20) → prompt (2) → pre-checks →
  `git worktree add -b glm/delegate/<name> <path> HEAD` → spawn the worker with
  the exact glm-worker args/env, `cwd` = worktree → report.
- Pre-checks before creating anything: branch already exists → `ERROR [31]`
  (hint: inspect/delete it); worktree dir already on disk → `ERROR [31]` (hint:
  delete it or `git worktree prune`); unborn HEAD (no commits yet) → `ERROR [31]`
  (hint: make an initial commit — delegate works from HEAD, uncommitted changes
  in the main checkout are *not* visible to the worker, which is the isolation).
- Lifecycle honors the repo's no-automatic-git-commits rule: the worktree and
  branch are **kept** after the run so the worker's edits are never destroyed;
  the footer prints the worktree path and the merge/inspect next steps.
  `--remove` removes the worktree after a *successful* run only — plain
  `git worktree remove`, which refuses on dirty trees; if it refuses, the
  worktree is kept and the git message is surfaced. The branch is always kept.
- SIGINT/exit-code propagation, secret handling, and env injection are
  inherited from `spawnAgent`/`createGlmEnv` unchanged. Git subprocesses run
  with argument arrays, the parent env (never the GLM child env), and
  `windowsHide`.
- `--dry-run` prints the plan (path, branch, prompt source) after the read-only
  checks and creates nothing; `--json` prints a pre-flight object and a result
  object (`{exitCode, worktree, branch, removed}`) around the streamed child
  output; `--quiet` suppresses the banners but never the child's own output.

Out of scope: auto-merge back, parallel multi-worker dispatch in one invocation
(run several `delegate`s concurrently — distinct names cannot collide),
`delegate --list/--clean` subcommands (plain `git worktree list` covers it),
and Linux/macOS (still v0.2 roadmap leftovers).

## Scope

- `src/core/git.ts` (new): `runGit` (never throws on non-zero; ENOENT →
  `GIT_NOT_FOUND`), `gitTopLevel` (strict variant of `findProjectRoot`).
- `src/core/worktree.ts` (new): name validation, branch/path derivation,
  `createDelegateWorktree` / `removeDelegateWorktree` / `branchExists`.
- `src/core/errors.ts`: `GIT_NOT_FOUND` (30), `GIT_REPO_REQUIRED` (30),
  `WORKTREE_FAILED` (31), `INVALID_DELEGATE_NAME` (2) — all reusing spec §35
  code families, mirroring how `managedBlockCorrupt` reuses 31.
- `src/commands/delegate.ts` (new): `delegateCommand(name, args, options, deps)`
  with the repo-standard injectable `deps` (`cwd`, `home`, `env`, `readUserEnv`,
  `readStdinFn`, `spawn`, `runGit`) — no `vi.mock`.
- `src/cli.ts`: `delegate <name> [prompt...]` with `--profile`, `--remove`.
- Tests: `tests/unit/worktree.test.ts` (validation, derivation, failure
  wrapping via injected runner), `tests/integration/delegate-command.test.ts`
  (real git in temp repos + fake-agent spawn in the worktree).
- Docs: README delegate section, AGENTS.md structure lines, MEMORY.md,
  version → 0.3.0.

## Acceptance criteria

- [ ] `delegate <name> "task"` in a git repo creates worktree + branch, runs the
      worker with glm-worker's exact args/env and `cwd` inside the worktree,
      keeps both, and returns the worker's exit code.
- [ ] Two delegates with different names coexist (no shared state).
- [ ] Second delegate with the *same* name fails `ERROR [31]` before creating
      anything, with an actionable hint; leftover worktree dir ditto.
- [ ] Non-git cwd → `ERROR [30] GIT_REPO_REQUIRED`; empty repo (no commits) →
      `ERROR [31]` telling the user to commit first.
- [ ] `--remove` on success with a clean tree removes the dir, keeps the
      branch; with worker-written changes git refuses, dir is kept, message
      surfaced, exit code still the worker's 0.
- [ ] Profile: implicit same-name profile and explicit `--profile` both apply;
      unknown explicit → `ERROR [11]`.
- [ ] `--dry-run` creates nothing; `--json` pre-flight/result objects are valid
      JSON; no secret value (key) appears in any output or error.
- [ ] Bad name (`../evil`, `a b`, `-x`, `.git`) → `ERROR [2]`; no prompt and no
      stdin → `ERROR [2] PROMPT_REQUIRED`.
- [ ] `npm run build`, `npm test`, `npm run lint` green.

## Validation

```
npm run build && npm test && npm run lint
npx vitest run tests/unit/worktree.test.ts tests/integration/delegate-command.test.ts
# real run (needs key + claude): glm-router delegate smoke "Reply DELEGATE_OK"
```
