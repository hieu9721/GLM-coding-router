# GLM Coding Router

GLM Coding Plan workers for Claude Code and Codex, on Windows.

Claude Code and Codex stay your orchestrators — they keep responsibility for requirements,
architecture, review, and integration. `glm-coding-router` delegates well-scoped
implementation work (exploration, CRUD, boilerplate, tests, mechanical refactoring) to
GLM workers via Z.ai's Anthropic-compatible endpoint.

One global npm install replaces the manual `.cmd` shim setup:

```text
Claude / Codex → shell → glm-worker → claude.exe harness → Z.ai endpoint → GLM Coding Plan
```

## Architecture

```text
                         Developer
                             │
             ┌───────────────┴───────────────┐
             ▼                               ▼
       Claude Code                         Codex
             │                               │
             └───────────────┬───────────────┘
                        shell command
                             │
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
    glm-chat  glm-fast  glm-worker  glm-review
        │         │          │          │
        └─────────┴──────────┴──────────┘
                        claude.exe
              (injected environment only)
                             │
                             ▼
              https://api.z.ai/api/anthropic
                             │
                             ▼
                    GLM Coding Plan
                    GLM-5.3 / GLM-5.3-Flash
```

## Requirements

- Windows 10/11 (v0.1; Linux/macOS planned for v0.2)
- Node.js >= 20
- Claude Code (`claude.exe`) — the GLM commands run on the Claude Code harness
- Codex (optional — Claude-only setups are fully supported)
- A Z.ai Coding Plan API key

No Anthropic pay-as-you-go, no OpenAI API, no LiteLLM, no proxy.

## Installation

```powershell
npm install -g glm-coding-router
glm-router init
```

`npx glm-coding-router init` also works for a one-off check, but the global install is
what puts `glm-worker` on your PATH long-term.

## Quick start

After `glm-router init`:

```powershell
glm-chat
glm-fast
glm-worker "Implement validation and add tests"
glm-review "Analyze the auth module"
```

## glm-chat

Interactive GLM-backed Claude Code session. Resolves the Z.ai key, locates `claude.exe`,
injects the Z.ai environment **into the child process only**, and spawns it with
pass-through arguments:

```powershell
glm-chat
glm-chat --version
glm-chat --any-claude-flag
```

Your normal `claude` command and its authentication are untouched.

## glm-fast

Interactive GLM-backed session pinned to the **fast model** (`models.fast`,
`glm-5.3-flash` by default) — every model slot in the child environment maps to
it, so whichever tier Claude Code picks, it gets the fast model. Same pass-through
arguments as `glm-chat`:

```powershell
glm-fast
glm-fast --profile air
```

## glm-worker

Headless implementation worker:

```powershell
glm-worker "Implement validation and add tests"
```

Or via stdin (a structured task packet):

```powershell
@"
TASK:
Implement refresh token validation.

SCOPE:
internal/auth/

VALIDATION:
go test ./internal/auth/...
"@ | glm-worker
```

Input priority: **stdin → arguments → error**. The worker runs with
`--max-turns 20 --permission-mode acceptEdits --tools Read,Glob,Grep,Edit,Write,Bash`.
It never uses `--dangerously-skip-permissions`.

## glm-review

Read-only worker for repository exploration, call-graph discovery, duplicate detection,
dependency inspection, and preliminary review:

```powershell
glm-review "Inspect this repository"
```

Runs with `--tools Read,Glob,Grep` — it cannot edit files or run commands.

## Profiles

All four task binaries (`glm-chat`, `glm-fast`, `glm-worker`, `glm-review`)
accept `--profile <name>` to overlay saved model/maxTurns settings. Profiles
live in `config.json`:

```json
{
  "profiles": {
    "test":     { "workerMaxTurns": 10, "fast": "glm-5.3-flash" },
    "frontend": { "main": "glm-5.3", "reviewMaxTurns": 30 }
  }
}
```

```powershell
glm-worker --profile test "Add failing test then fix it"
glm-review --profile frontend "Review the component tree"
```

Fields (all optional): `main`, `fast`, `workerMaxTurns`, `reviewMaxTurns`.
Unknown profile names fail with `ERROR [11]` listing the available ones.
Note: `--profile` belongs to these wrappers — it shadows Claude Code's own
`--profile` flag inside them.

## delegate

Run a GLM worker in an **isolated git worktree** so parallel tasks never trample
each other's working tree (`glm-router delegate backend|frontend|tests`):

```powershell
glm-router delegate backend "Implement refresh token validation in internal/auth"
Get-Content task.md | glm-router delegate auth-refresh
```

Each run creates a worktree at `<repo>.glm-worktrees\<name>` (outside the repo,
so your checkout's status stays clean) on a new branch `glm/delegate/<name>`
cut from `HEAD`, and runs the standard `glm-worker` inside it. The worktree and
branch are **kept** after the run — the tool never commits, merges, or deletes
your work; the footer prints the path and the merge command:

```text
[glm-router] worktree kept at D:\code\my-repo.glm-worktrees\backend
[glm-router] next: inspect it, then merge glm/delegate/backend (or discard with git worktree remove)
```

- Prompt priority is stdin → arguments, same as `glm-worker`.
- Profiles: `--profile test` explicitly, or — when omitted — a profile literally
  named after the delegate (`delegate test` → the `test` profile) if one exists.
- `--remove` deletes the worktree **after a successful run only**; plain
  `git worktree remove` is used, so git refuses (and the worktree is kept) when
  the worker left uncommitted changes. The branch is always kept.
- Pre-flight checks fail fast (`ERROR [31]`) when the branch or directory
  already exists, or the repo has no commits yet; outside a git repo →
  `ERROR [30]`. Uncommitted changes in your main checkout are **not** visible
  to the worker — it starts from the last commit.
- `--dry-run` prints the plan; `--json` prints pre-flight and result objects.
- Run several delegates concurrently — distinct names cannot collide:

```powershell
glm-router delegate backend "Task A"   # terminal 1
glm-router delegate tests "Task B"     # terminal 2
```

## benchmark

Measure the Claude Code + GLM stack on built-in coding tasks (spec §54 v0.4).
Each task runs in a throwaway temp directory: the router writes the task files,
spawns the standard GLM worker (same env injection, plus `--output-format json`
to capture the result document), then runs the task's validation command:

```powershell
glm-router benchmark --yes                 # both built-in tasks, 1 run each
glm-router benchmark --yes --task fn-reverse --repeat 3
glm-router benchmark --yes --max-turns 15
```

Report (per task × run): **duration**, **GLM calls** (assistant turns),
**retries** (`-` — not exposed by Claude Code yet), **tokens in/out**,
**tests** (PASS/FAIL of `node test.js`), **success**, **intervention**
(`needed` when the run did not self-complete). The full JSON report is always
saved to `%USERPROFILE%\.glm-coding-router\benchmarks\benchmark-<timestamp>.json`
and `--json` also prints it.

Built-in tasks: `fn-reverse` (implement `reverseWords` until the test passes),
`fix-bug` (repair an even-length `median` bug).

Notes:
- Benchmarking makes **real GLM API calls** — interactive runs ask for
  confirmation; non-interactive runs require `--yes`.
- Failed tasks are measurements, not errors: the command exits 0 once the
  suite ran. Missing key/claude or a broken spawn still fail with the usual
  `ERROR [10]/[20]/[40]`.
- `--stack codex` is recognized but not supported yet (headless Codex
  orchestration isn't drivable today); the harness is stack-shaped so it can
  be added later.

## usage

Provider usage snapshots (spec §54 v0.5) — what is reliably retrievable:

```powershell
glm-router usage
```

- **Z.ai Coding Plan quota** (network): queries the Z.ai monitor endpoint
  (`/api/monitor/usage/quota/limit`) with your key and shows each credit
  window — consumed/total, percentage, reset time — plus the plan level.
  Unreachable endpoint or a rejected request renders `✗ <reason>` and exits 1.
- **Local totals** (offline): aggregates saved benchmark reports — run count
  and summed input/output tokens (`glm-router benchmark` writes them).
- **Claude quota / Codex usage**: always shown as "not available" — neither
  exposes a headless usage API today (and claude.ai quota is irrelevant while
  traffic is routed to GLM).

`--json` emits the same data machine-readably. No key configured → `ERROR [10]`.

## Agent skills (Claude Code + Codex)

`glm-router skill install` writes the `glm-delegation` SKILL.md into **both**
agent homes — `~/.claude/skills/` and `~/.codex/skills/` — so either
orchestrator natively knows how to delegate to GLM workers. Missing homes are
skipped with a note (optional enhancement, never fatal); `skill remove`
cleans both. `status` shows one skill row per agent.

## MCP server (optional)

`glm-mcp` (installed with the package) exposes the router as MCP tools over
stdio — any MCP client can delegate without shell syntax:

| Tool | What it does |
|---|---|
| `glm_worker(prompt, profile?)` | implementation worker, returns output |
| `glm_review(prompt, profile?)` | read-only review/exploration |
| `glm_delegate(name, prompt)` | worker in an isolated git worktree |
| `glm_usage()` | Z.ai quota windows + local benchmark totals |

Register it with Claude Code (we never edit `~/.claude.json` ourselves — it
goes through Claude's own CLI):

```powershell
glm-router mcp             # prints the snippet + the exact command
glm-router mcp install     # claude mcp add -s user glm-coding-router -- node .../glm-mcp.js
glm-router mcp remove      # claude mcp remove -s user glm-coding-router
```

Tool-level failures return `isError` results (missing key, no claude, outside
a git repo, unreachable endpoint); the server never prints anything to stdout
except JSON-RPC frames.

## CLI reference

```text
glm-router init              guided setup
glm-router doctor [--network]  full runtime diagnosis
glm-router status            quick offline overview
glm-router key set           store ZAI_API_KEY (Windows User Environment)
glm-router key check         key configured? from which source?
glm-router config show
glm-router config set models.main glm-5.3
glm-router delegate <name>   run a GLM worker in an isolated git worktree
glm-router benchmark         measure the Claude+GLM stack on built-in tasks
glm-router usage             Z.ai quota snapshot + local benchmark totals
glm-router mcp               optional MCP server registration (glm-mcp)
glm-router project init      CLAUDE.md / AGENTS.md managed blocks (--dry-run supported)
glm-router project remove
glm-router skill install     optional Codex delegation skill
glm-router skill remove
glm-router uninstall         guided removal (keeps ZAI_API_KEY by default)
```

Global flags: `--json --quiet --verbose --dry-run --force --yes`

## Claude integration

`glm-router project init` adds a **managed block** to `CLAUDE.md` at the project root
(`git rev-parse --show-toplevel`, falling back to cwd):

```text
<!-- glm-coding-router:start -->
... delegation policy ...
<!-- glm-coding-router:end -->
```

- Everything outside the markers is preserved; existing blocks are replaced in place;
  runs are idempotent and never duplicate.
- Files are updated atomically (tmp file → fsync → rename).
- On a malformed marker pair the file is left untouched with an actionable error.
- CRLF/LF and UTF-8 are preserved.
- `glm-router project remove` deletes only the managed block. A file the router
  created entirely is deleted only when it would otherwise be empty.

## Codex integration

The same command updates `AGENTS.md` (Codex's repository instruction file) with an
equivalent managed block. Additionally, `glm-router skill install` installs the optional
`glm-delegation` skill to `~/.codex/skills/glm-delegation/SKILL.md`. If Codex is not
detected, the skill step warns and skips — AGENTS.md integration and the core tool are
unaffected.

## Orca behavior (stale environments)

Terminals embedded in Orca snapshot the Windows environment at startup. A key added
after Orca starts is invisible to those terminals. Every GLM command therefore resolves
the key in this order:

1. `process.env.ZAI_API_KEY`
2. Windows User Environment (via PowerShell)
3. fail with an actionable error

The key is never cached to disk.

## Security model

- The key lives only in the Windows User Environment; it is never written to
  `config.json`, the repo, logs, or stack traces. Debug output redacts
  `ZAI_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and Authorization headers.
- Z.ai routing environment variables (`ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, model overrides) are injected **only** into the spawned
  `claude.exe` child process. `ANTHROPIC_API_KEY` is blanked in the child so your
  normal Claude auth is never in play. `ANTHROPIC_BASE_URL` is never persisted globally.
- Claude Code and Codex global authentication are never modified.
- Child processes are spawned with argument arrays (`shell: false`) — prompts with
  quotes, pipes, ampersands, or newlines are passed verbatim, never through a shell.
- No telemetry, no automatic git commits.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ERROR [ZAI_KEY_MISSING]` | `glm-router key set`, then open a **new** terminal |
| `ERROR [CLAUDE_NOT_FOUND]` | Install Claude Code, or `glm-router config set claudePath C:\path\to\claude.exe` |
| Key works in a new terminal but not inside Orca | Expected — workers re-read the Windows User Environment automatically; run `glm-router doctor` to confirm |
| `glm-*` not on PATH after install | Reopen the terminal; check `npm config get prefix` is on PATH |
| `ERROR [MANAGED_BLOCK_CORRUPT]` | Fix the marker pair in the named file manually, then re-run |

Run `glm-router doctor` (add `--network` to probe the Z.ai endpoint) for a full diagnosis.

## Uninstall

```powershell
glm-router uninstall
```

The wizard removes the config, the Codex skill, and optionally the current project
integration. `ZAI_API_KEY` is **kept** by default — removing credentials requires
explicit consent. Finish with `npm uninstall -g glm-coding-router`.

## Development

```powershell
npm install
npm run build      # tsc → dist/
npm test           # vitest run
npm run lint       # eslint src tests
npm run dev        # tsx src/cli.ts <args>
```

Integration tests spawn `tests/fixtures/fake-agent.mjs` (via `node.exe`) to verify
argument passing, environment injection, and exit-code propagation without spending
API quota. See the `docs/GLM Coding Router — Technical Specification v0.1.md` for the full
v0.1 contract (exit codes, managed-block test matrix, acceptance criteria).

## Publishing

```powershell
npm run build
npm test
npm publish
```

`prepublishOnly` runs build + tests. The package ships only `dist/`; the four binaries
(`glm-router`, `glm-chat`, `glm-fast`, `glm-worker`, `glm-review`) are declared in `bin`.

## License

MIT
