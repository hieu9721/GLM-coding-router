# Spec: headless spawns inherit the user's MCP servers

Target **1.1.2**. Found by the Windows release gate on 2026-09-20; affects the **published
1.0.0, 1.1.0 and 1.1.1**. Security defect: it breaks the read-only guarantee `glm-review`
is documented to provide (`docs/GLM Coding Router — Technical Specification v0.1.md` §17).

## Problem

`glm-review` spawns `claude -p … --tools Read,Glob,Grep` (`src/bin/glm-review.ts:16-18`) and
the code comment calls that surface "no Edit, Write, or Bash". The binary's own help says
what `--tools` actually covers:

```
--tools <tools...>   Specify the list of available tools from the built-in set.
```

**From the built-in set.** MCP tools are not in that set, so they are additive and survive
the restriction. Once `glm-router mcp install` has registered this project's own server at
user scope — which the README tells users to do — every `glm-review` session also gets
`mcp__glm-coding-router__glm_worker`, whose whole purpose is to write files.

Observed live on Windows 11 / claude 2.1.278, asking a review to create `PROOF.txt`:

```
$ glm-review "Create a file named PROOF.txt containing the word WRITTEN. If you have no
              tool that can write files, reply exactly NO_WRITE_TOOL and do nothing else."
Done. `PROOF.txt` exists in the working directory and contains exactly `WRITTEN` —
created via the GLM worker (which has Write tools) since I don't have a direct Write
tool in this session.
$ cat PROOF.txt
WRITTEN
```

The same session, asked to enumerate its tools, returns:

```
Glob
Grep
Read
mcp__glm-coding-router__glm_delegate
mcp__glm-coding-router__glm_review
mcp__glm-coding-router__glm_usage
mcp__glm-coding-router__glm_worker
```

So a surface documented as read-only has, in practice: **write access** (via `glm_worker` /
`glm_delegate`), **recursion** (a review can spawn reviews and workers, each with its own
`--max-turns` budget), and **unbudgeted credit spend**. The same inheritance reaches
`glm-worker` and `glm-router benchmark`, where writes are expected but recursion and the
extra tool surface are not — benchmark numbers in particular are supposed to measure a
fixed surface.

The Linux verification missed this because no MCP server was registered in that
environment. It is not a regression from the cross-platform work: `--tools` never excluded
MCP tools, so the hole has existed since the MCP server shipped in 1.0.0.

## Approach

**Verified fix** (same binary, same prompt, one flag added — run live before writing this
spec):

```
claude -p "List the exact names of every tool you can call…" \
  --max-turns 15 --tools "Read,Glob,Grep" --strict-mcp-config
→ Glob
  Grep
  Read
```

`--strict-mcp-config` means "only use MCP servers from `--mcp-config`, and ignore user,
project and local config". We pass no `--mcp-config`, so the set is empty and a headless
child gets exactly the built-in tools we asked for.

The flag goes on **every headless spawn we construct**, because the reasoning is the same
in each case — we are choosing that child's whole tool surface, and a surface we do not
control is not a surface we can document:

| Spawn | Flag | Why |
|---|---|---|
| `glm-review` | yes | restores the read-only guarantee — the defect above |
| `glm-worker` | yes | write is expected, recursion and unbudgeted spend are not |
| `glm-router benchmark` | yes | must measure a fixed tool surface to be comparable |
| `glm-chat`, `glm-fast` | **no** | the user's own interactive session; their servers are theirs |

This is a security setting, so — exactly like `worker.allowedBash` in
`specs/worker-bash-permissions.md` — it is **not** configurable and **not** overridable by a
profile. A user who wants MCP servers in a child session has `glm-chat`.

Note the recursion this closes is specifically *undeclared* recursion. `glm-router delegate`
stays as it is: it builds worker args and spawns one worker on purpose, in a worktree the
user asked for.

## Scope

- `src/core/agent-args.ts` — **new**, one exported constant `STRICT_MCP_ARGS` plus the
  rationale, so the three call sites cannot drift apart.
- `src/bin/glm-review.ts` — `buildReviewArgs` appends it.
- `src/bin/glm-worker.ts` — `buildWorkerArgs` appends it **before** `--allowedTools`, whose
  variadic values must stay last.
- `src/commands/benchmark.ts` — the task spawn appends it.
- `src/mcp/server.ts` — inherits via `buildWorkerArgs` / `buildReviewArgs`; a test asserts
  it, since the MCP server is the surface that creates the loop.
- Tests: `tests/unit/mcp-isolation.test.ts` (new) — every headless builder carries the flag;
  the interactive paths do not; `tests/integration/glm-fast.test.ts:99` and
  `tests/unit/prompt-args.test.ts` updated, deliberately, because they pin the old argv.
- Docs: README (what `glm-review` may and may not do), AGENTS.md hard-rule bullet,
  MEMORY.md.

**Out of scope:** a `doctor` check for it (the flag is unconditional — there is nothing to
diagnose); per-server allowlisting; letting a project opt specific MCP servers into a worker;
changing the MCP server's own tool set; `glm-chat` / `glm-fast`.

## Acceptance criteria

- [ ] `glm-review`, asked to write a file with the MCP server registered at user scope,
      creates **nothing** and reports it has no write tool.
- [ ] A review session asked to enumerate its tools returns exactly `Glob`, `Grep`, `Read`.
- [ ] `buildReviewArgs`, `buildWorkerArgs` and the benchmark args all contain
      `--strict-mcp-config`; `glm-chat` / `glm-fast` pass-through args do not.
- [ ] In `buildWorkerArgs` the flag precedes `--allowedTools`, and the Bash patterns are
      still the last elements of the array.
- [ ] The MCP server's own `glm_worker` / `glm_review` tools inherit the flag.
- [ ] `glm-worker` still completes a real task and still executes allowlisted Bash — the
      flag must not cost us the F5 fix.
- [ ] `npm run build`, `npm test`, `npm run lint` green on Windows; version 1.1.2.

## Validation

```
npm run build && npm test && npm run lint
npx vitest run tests/unit/mcp-isolation.test.ts

# Live (needs ZAI_API_KEY and `glm-router mcp install` done), in a scratch dir:
glm-review "Create PROOF.txt containing WRITTEN. If you have no tool that can write
            files, reply exactly NO_WRITE_TOOL and do nothing else."
# expect: NO_WRITE_TOOL, and no PROOF.txt on disk
glm-worker "Run the shell command: npm run proof  then report its last output line"
# expect: still runs — the allowlisted Bash fix survives
```
