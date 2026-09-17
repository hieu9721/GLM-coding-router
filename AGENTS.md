# AGENTS.md — GLM Coding Router

## Project purpose

npm CLI (`glm-coding-router`, CLI name `glm-router`) that lets Claude Code and Codex act as orchestrators while GLM Coding Plan (via Z.ai's Anthropic-compatible endpoint `https://api.z.ai/api/anthropic`) does implementation work. Provides four binaries: `glm-router`, `glm-chat`, `glm-worker`, `glm-review`.

- v0.1 targets **Windows 10/11 only**, Node >= 20, TypeScript, ESM, distributed via npm.
- **This repo is currently spec-only.** The authoritative source is `GLM Coding Router — Technical Specification v0.1.md` — read the relevant sections before implementing anything. The spec is bilingual (Vietnamese/English); section numbers below refer to it.

## Planned structure (spec §30)

```
src/cli.ts            # main CLI entry (bin: glm-router)
src/bin/              # glm-chat.ts, glm-worker.ts, glm-review.ts
src/commands/         # init, doctor, status, uninstall, config, key, project-*
src/core/             # config, paths, zai-key, claude discovery, process spawn, platform
src/integrations/     # claude.ts, codex.ts, skill.ts
src/project/          # managed-block.ts, project-root.ts, atomic-write.ts
src/templates/        # managed-block content + glm-delegation SKILL.md
tests/{unit,integration,fixtures}
```

## Build & test (spec §31)

No package.json yet; use these scripts when creating it:

```
npm run dev      # tsx src/cli.ts
npm run build    # tsc
npm test         # vitest run
npm run lint     # eslint src tests
```

Deps: commander, prompts, zod; dev: typescript, tsx, vitest, eslint, @types/node.

## Hard rules

**Security (spec §38, §11, §37)**
- Never log, persist, or print `ZAI_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / Authorization headers. Redact in debug output. Key lives only in Windows User Environment, never in config.json or the repo.
- Z.ai env vars (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, model overrides) are injected **only into the spawned claude.exe child process** — never the parent shell, never global. `ANTHROPIC_API_KEY` is set to empty in child env.
- Never modify existing Claude Code or Codex authentication.
- Use `spawn(path, argsArray)` with env — never string `exec`, no `shell: true`, no unescaped PowerShell built from user data. Windows argument escaping matters.
- No telemetry, no automatic git commits.

**Key resolution (spec §10)**
- `resolveZaiApiKey()`: `process.env.ZAI_API_KEY` → Windows User Environment (via `powershell.exe -NoProfile -NonInteractive [Environment]::GetEnvironmentVariable(...,'User')`) → fail. Do not cache the key to disk. This exists because Orca terminals snapshot a stale environment.

**Managed blocks (spec §20–22, §46, §48)**
- `CLAUDE.md` / `AGENTS.md` edits go only inside `<!-- glm-coding-router:start/end -->` markers: append if absent, replace if present, never duplicate; preserve all content outside the block. On corrupt/malformed marker pairs, do not modify the file — return an actionable error.
- Write atomically (tmp file + rename), support `--dry-run`. Handle CRLF, LF, UTF-8, missing trailing newline.
- `project init` / `skill install` must be idempotent.

**Other invariants**
- Model names (`glm-5.3`, `glm-5.3-flash`) come from config (`%USERPROFILE%\.glm-coding-router\config.json`, zod-validated) — never hardcode in multiple places.
- Standard exit codes (spec §35): 10 key missing, 11 config invalid, 20 claude missing, 21 codex missing, 30 project root, 31 managed write, 40 child agent, 50 platform. Error messages use `ERROR [CODE]` format and are actionable.
- `glm-review` is read-only: `--tools Read,Glob,Grep` only. `glm-worker` uses `--tools`, never `--dangerously-skip-permissions`.
- Child processes inherit cwd/stdio, forward SIGINT (Ctrl+C must reach child claude), propagate exit code.
- Prompt input priority: stdin (when not a TTY) → args → error.
- Claude binary discovery: `where.exe claude` → PATH search → config override → error. Don't assume `claude.cmd`; standalone installs expose `claude.exe`. Codex absence is a WARN, not fatal (Claude-only setups must work).

## Implementation order (spec §56)

Core runtime first — do not start with the wizard or Codex skill:
package skeleton → locateClaude → resolveZaiApiKey → createGlmEnv → glm-chat → prompt parser → glm-worker → glm-review → config → doctor → status → managed-block engine → CLAUDE.md/AGENTS.md integrations → project init/remove → Codex skill → uninstall → tests → README.
