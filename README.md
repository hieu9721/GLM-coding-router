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

## CLI reference

```text
glm-router init              guided setup
glm-router doctor [--network]  full runtime diagnosis
glm-router status            quick offline overview
glm-router key set           store ZAI_API_KEY (Windows User Environment)
glm-router key check         key configured? from which source?
glm-router config show
glm-router config set models.main glm-5.3
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
API quota. See the `GLM Coding Router — Technical Specification v0.1.md` for the full
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
