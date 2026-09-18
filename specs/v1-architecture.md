# Spec: v1.0 architecture — dual-agent skill + optional MCP (spec §54)

## Problem

Spec §54 v1.0 sketches the target architecture: `CLI + Agent Skill + optional
MCP + plugin packaging`. Today the CLI is complete (v0.1–v0.5), but the
delegation skill is Codex-only and there is no MCP surface — orchestrators
must shell out to remember command syntax instead of discovering tools.

## Approach

Three additions; nothing existing changes behavior:

1. **Agent Skill for both orchestrators.** The `glm-delegation` SKILL.md now
   installs into Claude Code too (`~/.claude/skills/<name>/SKILL.md`), not
   just Codex (`~/.codex/skills/…`). New `ClaudeSkillInstaller` implementing
   the existing `SkillInstaller` interface (same conservative detect: home
   dir missing → warn+skip, never fatal, spec §27). `skill install` /
   `skill remove` iterate both targets and report per agent;
   `status` shows `Claude skill` / `Codex skill` rows; `doctor` gains a
   matching Claude skill check. Idempotent as before.

2. **Optional MCP server: `glm-mcp` (6th binary).** A stdio JSON-RPC 2.0
   server (newline-delimited frames) exposing the router as MCP tools so any
   MCP client (Claude Code, Codex, others) can delegate without shell syntax.
   Hand-rolled protocol layer — **no new npm dependency** (the tools subset
   needs only initialize / notifications/initialized / ping / tools/list /
   tools/call). Server: `serverInfo {name: "glm-coding-router", version}`;
   `protocolVersion` echoes the client's requested version.
   Tools (implemented on core primitives, never on the CLI commands, so
   nothing ever writes to the protocol channel's stdout):
   - `glm_worker(prompt, profile?)` — headless worker via
     `buildWorkerArgs` + `spawnAgentCapture`; returns stdout; `isError` on
     non-zero exit (stderr tail appended).
   - `glm_review(prompt, profile?)` — read-only via `buildReviewArgs`.
   - `glm_delegate(name, prompt)` — the delegate lifecycle on the worktree
     engine: create branch + worktree from HEAD, run the worker with
     **captured** output, keep worktree + branch (no automatic commits),
     return summary (exit code, worktree path, branch, next step).
   - `glm_usage()` — the v0.5 snapshot as text (Z.ai quota + local totals);
     quota endpoint failure → `isError` with the reason, never a crash.
   Tool-level failures return `{content, isError: true}`; unknown methods
   get JSON-RPC `-32601`; malformed lines are ignored (null response).
   Same invariants as the CLI: key from `resolveZaiApiKey` (10-family
   errors surfaced as tool errors), env injected only into the spawned
   child, no secrets in any frame.

3. **`glm-router mcp` helper (registration, opt-in).**
   - `glm-router mcp` prints the JSON config snippet for manual registration
     plus the exact `claude mcp add` command.
   - `glm-router mcp install` runs
     `claude mcp add -s user glm-coding-router -- <node> <abs path to
     dist/bin/glm-mcp.js>` via Claude Code's own CLI (we never edit
     `~/.claude.json` ourselves); `mcp remove` runs the matching
     `claude mcp remove`. Claude missing → `ERROR [20]`. The server path is
     derived from this package's own module location, so it works from both
     a global npm install and a dev checkout. Injectable runner for tests.

**Plugin packaging** statement: the npm package is the packaging unit —
six binaries, dual-agent skills, and the opt-in MCP server all ship in the
one tarball (no separate marketplace/plugin artifact for v1.0).

Out of scope: MCP resources/prompts/sampling, non-Windows support (still
the v0.2 roadmap leftover), auto-registration on `init`, Codex-side MCP
config writing (Codex config surface for MCP is still moving; the JSON
snippet works for any client).

## Scope

- `src/integrations/skill.ts`: `ClaudeSkillInstaller` (+ shared base).
- `src/commands/skill.ts`, `status.ts`, `doctor.ts`: dual-target skill.
- `src/mcp/server.ts` (new): tool definitions, `callMcpTool`,
  `createMcpServer` (`handleLine(line) → frame | null`, pure — the stdio
  loop lives only in the bin).
- `src/bin/glm-mcp.ts` (new): readline loop wiring `handleLine` to stdout.
- `src/commands/mcp.ts` (new): snippet / install / remove.
- `src/cli.ts`: `mcp` command wiring; `package.json`: `glm-mcp` bin, 1.0.0.
- `src/commands/usage.ts`: export `fetchZaiQuota` for the MCP tool.
- Tests: `tests/unit/mcp-server.test.ts` (handlers + protocol),
  `tests/integration/skill-command.test.ts` extension,
  `tests/integration/mcp-command.test.ts`.
- Docs: README (v1.0 section: skills, MCP setup), AGENTS.md, MEMORY.md.

## Acceptance criteria

- [ ] `skill install` writes SKILL.md under both `~/.claude/skills/` and
      `~/.codex/skills/` when both homes exist; skips (warn, exit 0) per
      missing home; second run is a no-op; `skill remove` cleans both.
- [ ] `status` renders both skill rows; `doctor` has the Claude skill check.
- [ ] `glm-mcp` speaks the MCP subset: initialize → serverInfo + echoed
      protocolVersion; notifications produce no frame; ping → {};
      tools/list → the four tools with inputSchema; tools/call routes.
- [ ] `glm_worker`/`glm_review` return captured stdout and `isError` on
      non-zero exit; `glm_delegate` returns worktree/branch summary and
      keeps both; `glm_usage` renders quota or `isError` with the reason.
- [ ] No frame or tool result ever contains the key value; the server never
      writes anything to stdout except JSON-RPC frames.
- [ ] `mcp` prints a valid snippet; `mcp install`/`remove` invoke
      `claude mcp add/remove` with the derived server path; missing claude →
      `ERROR [20]`.
- [ ] `npm run build`, `npm test`, `npm run lint` green.

## Validation

```
npm run build && npm test && npm run lint
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' | node dist/bin/glm-mcp.js
# + tools/list and a real glm_usage call over the same pipe
```
