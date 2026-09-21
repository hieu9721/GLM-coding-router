# AGENTS.md — GLM Coding Router

**This file is the single source of truth for this repository.** `CLAUDE.md` is a stub that
points here — Claude Code and Codex must always see the same rules, so don't fork content
between the two files. See "Scaling beyond v0.1" at the bottom before adding new sections here.

## Project purpose

npm CLI (`glm-coding-router`, CLI name `glm-router`) that lets Claude Code and Codex act as orchestrators while GLM Coding Plan (via Z.ai's Anthropic-compatible endpoint `https://api.z.ai/api/anthropic`) does implementation work. Provides five binaries: `glm-router`, `glm-chat`, `glm-fast`, `glm-worker`, `glm-review`.

- Runs on **Windows 10/11** and **Linux** (both verified); **macOS is experimental** — designed
  but never executed on a Mac (`specs/cross-platform.md`). Node >= 20, TypeScript, ESM, npm.
- The authoritative source is `docs/GLM Coding Router — Technical Specification v0.1.md` — read the relevant sections before changing behavior. The spec is bilingual (Vietnamese/English); section numbers referenced here come from it.

## Session memory

Read `MEMORY.md` before starting a task — current status, decisions made outside the spec, and
constraints discovered while building. After finishing a task, append a session-log line and
update the decisions/constraints tables if something changed. Keep it short.

## Structure (spec §30)

```
Claude Code / Codex → shell command → glm-chat / glm-worker / glm-review → claude.exe
                                       (Z.ai env injected into child only) → api.z.ai/api/anthropic
```

- `src/cli.ts` — main CLI entry (`glm-router`), built with commander. Each subcommand
  (`init`, `doctor`, `status`, `key`, `config`, `delegate`, `benchmark`, `usage`, `mcp`, `project`,
  `skill`, `uninstall`) lives in `src/commands/` and is wired here.
- `src/bin/{glm-chat,glm-fast,glm-worker,glm-review}.ts` — the four thin task binaries that
  resolve the Z.ai key, locate `claude.exe`, build the injected env, and spawn the child process.
  `glm-chat` is interactive; `glm-fast` is interactive pinned to the fast model; `glm-worker`
  runs with `--tools Read,Glob,Grep,Edit,Write,Bash` plus an `--allowedTools` Bash allowlist
  (`specs/worker-bash-permissions.md`); `glm-review` is read-only with
  `--tools Read,Glob,Grep`. All four accept `--profile <name>` (see `specs/glm-fast-profiles.md`).
- `src/core/` — shared runtime: `config.ts` (zod-validated config), `paths.ts`, `zai-key.ts` (key
  resolution), `claude.ts` (`locateClaude`/`locateCodex` discovery), `env.ts` (`createGlmEnv`,
  the child-only environment), `process.ts` (`spawnAgent`), `prompt.ts` (stdin/args resolution),
  `profile.ts` (`extractProfileFlag`/`applyProfile`), `git.ts` (`runGit`/`gitTopLevel` for
  delegate), `worktree.ts` (delegate worktree lifecycle, see `specs/delegate-worktrees.md`),
  `platform.ts` (`platformSupport`/`platformName`), `user-env.ts` (per-user secret store
  dispatcher: Windows User Environment / macOS keychain / libsecret / none), `errors.ts`
  (`GlmRouterError`, `ExitCode`, `Errors` factory), `logging.ts` (`redact`), `main-guard.ts`
  (`isMainModule`), `version.ts`.
- `src/integrations/` — `claude.ts` and `codex.ts` wire the managed-block engine into each tool's
  instruction file; `skill.ts` installs/removes the `glm-delegation` skill into BOTH agent homes
  (`~/.claude/skills`, `~/.codex/skills`, specs/v1-architecture.md).
- `src/project/` — the managed-block engine: `managed-block.ts` (parse/insert/replace between
  markers), `managed-file.ts`, `project-root.ts` (`git rev-parse --show-toplevel` with cwd
  fallback), `atomic-write.ts` (tmp file + rename), `ownership.ts`.
- `src/templates/` — the managed-block content (`claude-block.ts`, `agents-block.ts`), the
  `glm-delegation` SKILL.md content, and the built-in benchmark task suite
  (`benchmark-tasks.ts`, see `specs/benchmark.md`).
- `src/mcp/` — the glm-mcp MCP server (stdio JSON-RPC, tools built on core primitives only —
  never on the CLI commands, stdout is the protocol channel; specs/v1-architecture.md). Bin
  `src/bin/glm-mcp.ts` wires the readline loop; `glm-router mcp` registers it via `claude mcp add`.
- `tests/{unit,integration,fixtures}` — integration tests exercise the real command surface
  against `tests/fixtures/fake-agent.mjs` standing in for `claude.exe`.

ESM with NodeNext resolution: relative imports in `src/` **must** use the `.js` suffix (they
refer to the compiled output, not the `.ts` source).

## Build & test

```
npm run build      # tsc → dist/
npm test           # vitest run
npm run test:watch # vitest (watch mode)
npm run lint       # eslint src tests
npm run dev        # tsx src/cli.ts <args>
```

Run a single test file: `npx vitest run tests/unit/managed-block.test.ts`
Run tests matching a name: `npx vitest run -t "managed block"`

Integration tests spawn `tests/fixtures/fake-agent.mjs` through `node.exe` to verify args/env/exit codes without API quota — extend that fixture rather than calling real GLM.

`prepublishOnly` runs build + tests before `npm publish`.

## Hard rules

**Security (spec §38, §11, §37)**
- Never log, persist, or print `ZAI_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / Authorization headers. Redact in debug output via `logging.ts#redact`. Key lives only in the platform's per-user store (or the user's own shell profile), never in config.json or the repo.
- Z.ai env vars (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, model overrides) are injected **only into the spawned claude.exe child process** (`createGlmEnv` in `src/core/env.ts`) — never the parent shell, never global. `ANTHROPIC_API_KEY` is set to empty in child env.
- Never modify existing Claude Code or Codex authentication.
- Use `spawn(path, argsArray)` with env — never string `exec`, no `shell: true`, no unescaped PowerShell built from user data. Windows argument escaping matters.
- No telemetry, no automatic git commits.
- Every headless spawn we construct passes `STRICT_MCP_ARGS` (`src/core/agent-args.ts`): `--tools` restricts only the built-in set, so without it a child inherits the user's MCP servers — which gave read-only `glm-review` a write-capable `glm_worker` (specs/review-mcp-isolation.md). Not configurable, not profile-overridable. Interactive `glm-chat`/`glm-fast` are excluded by design.

**Key resolution (spec §10)**
- `resolveZaiApiKey()` in `src/core/zai-key.ts`: `process.env.ZAI_API_KEY` → the platform's per-user store via `src/core/user-env.ts` (Windows: `powershell.exe … GetEnvironmentVariable(…,'User')`; macOS: `security`; Linux: `secret-tool` when installed; otherwise none) → fail. Read fresh on every invocation, never cached to disk. This exists because Orca terminals snapshot a stale environment.

**Managed blocks (spec §20–22, §46, §48)**
- `CLAUDE.md` / `AGENTS.md` edits go only inside `<!-- glm-coding-router:start/end -->` markers: append if absent, replace if present, never duplicate; preserve all content outside the block. On corrupt/malformed marker pairs, do not modify the file — return an actionable error (`Errors.managedBlockCorrupt`).
- Write atomically (tmp file + rename via `atomic-write.ts`), support `--dry-run`. Handle CRLF, LF, UTF-8, missing trailing newline.
- `project init` / `skill install` must be idempotent.
- The stub/pointer wording in `CLAUDE.md` (see "Scaling beyond v0.1") lives **outside** the managed block and is separate from it — the managed-block engine must keep writing its own block into both files unchanged.

**Other invariants**
- Model names (`glm-5.3`, `glm-5.3-flash`) come from config (`%USERPROFILE%\.glm-coding-router\config.json` / `~/.glm-coding-router/config.json`, zod-validated) — never hardcode in multiple places.
- Standard exit codes (spec §35, `src/core/errors.ts`): 10 key missing, 11 config invalid, 20 claude missing, 21 codex missing, 30 project root, 31 managed write, 40 child agent, 41 quota insufficient, 42 handoff required, 50 platform. Error messages use `ERROR [CODE]` format (`formatGlmError`) and are actionable. **41 and 42 are not crashes** (specs/v2-architecture.md, D2): both mean "unfinished, work preserved" and print a `HandoffResult` JSON on stdout — 41 is a preflight refusal that spawned nothing, 42 a mid-run handoff with a bundle. An orchestrator reads them as "continue in the same worktree", never as "the worker broke".
- `glm-review` is read-only: `--tools Read,Glob,Grep` only. `glm-worker` uses `--tools`, never `--dangerously-skip-permissions` — and never `--permission-mode bypassPermissions`, which is the same thing renamed.
- The worker's Bash access is an explicit allowlist (`worker.allowedBash`, `specs/worker-bash-permissions.md`): validation commands only, never git writes / `rm` / network / installs. `acceptEdits` alone denies **every** Bash call in headless mode, so the allowlist is what makes the tool usable — removing it silently disables validation.
- The Z.ai key lives in the platform's own per-user store (`src/core/user-env.ts`): Windows User Environment, macOS keychain, or libsecret when `secret-tool` exists. Where there is none, the tool **prints guidance and never invents a file of its own** — the key is still never written anywhere this package owns.
- Child processes inherit cwd/stdio, forward SIGINT (Ctrl+C must reach child claude), propagate exit code.
- Prompt input priority: args → stdin (when not a TTY) → error (`src/core/prompt.ts`). Args are checked first and stdin is never awaited when they carry a prompt: stdin-first deadlocks whenever the pipe never reaches EOF, which is the normal shape under an agent harness or CI.
- Claude binary discovery (`src/core/claude.ts`): `where.exe claude` → PATH search → config override → error. Don't assume `claude.cmd`; standalone installs expose `claude.exe`. Codex absence is a WARN, not fatal (Claude-only setups must work).

## Implementation order (spec §56)

Core runtime first — do not start with the wizard or Codex skill:
package skeleton → locateClaude → resolveZaiApiKey → createGlmEnv → glm-chat → prompt parser → glm-worker → glm-review → config → doctor → status → managed-block engine → CLAUDE.md/AGENTS.md integrations → project init/remove → Codex skill → uninstall → tests → README.

## Scaling beyond v0.1

The Technical Specification covers v0.1 only. Work that goes beyond it needs a home that isn't
this file, or "Hard rules" and "Structure" turn into an unmaintainable changelog:

- **New feature or behavior change beyond the spec** → write `specs/<short-name>.md` first (copy
  `specs/TEMPLATE.md`), then implement. Don't inline feature-specific design here.
- **Decisions made outside the spec, constraints discovered while building, current status** →
  `MEMORY.md`, not here. This file only holds stable, tool-agnostic facts that stay true across
  sessions; `MEMORY.md` is the place for things that change as work happens.
- **A genuinely new invariant** (something that must always hold, not a one-off decision) → one
  bullet under "Hard rules", not a paragraph.
- **`CLAUDE.md`** stays a stub pointing here. If Claude Code needs behavior Codex doesn't, add it
  to the stub directly — never re-explain something this file already says.

<!-- glm-coding-router:start -->

## GLM Worker Delegation

Available commands:

- `glm-worker "<task>"`
- `glm-review "<task>"`

Codex is the primary orchestrator.

Delegate:
- CRUD
- boilerplate
- tests
- documentation
- mechanical refactoring
- repository exploration
- straightforward implementation

Keep in Codex:
- requirements
- planning
- architecture
- ambiguous business logic
- complex debugging
- security decisions
- integration
- final review

Before delegation create a task packet:

TASK
SCOPE
FILES ALLOWED TO MODIFY
FILES NOT TO MODIFY
REQUIREMENTS
CONSTRAINTS
ACCEPTANCE CRITERIA
VALIDATION
EXPECTED OUTPUT

Never trust a worker's success report without inspecting the resulting changes.

<!-- glm-coding-router:end -->
