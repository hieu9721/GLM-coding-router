# Spec: the worker's Bash tool is denied on every call

Target **1.1.0** (ships with `specs/cross-platform.md`). Found by live testing on
2026-09-20; affects the **published 1.0.0**.

## Problem

`glm-worker` spawns `claude -p … --permission-mode acceptEdits --tools Read,Glob,Grep,Edit,Write,Bash`
(`src/bin/glm-worker.ts:16-28`). In headless `-p` mode `acceptEdits` auto-approves file
edits but **not** shell commands, and there is no interactive prompt to answer, so every
Bash call is refused. Captured on the wire (`tests/fixtures/streams/edit.ndjson`):

```json
{"type":"system","subtype":"permission_denied","tool_name":"Bash",
 "tool_use_id":"call_db62461…","decision_reason":"This command requires approval"}
```

The tool_result comes back `is_error: true` with the text `"This command requires approval"`,
and `result.permission_denials[]` lists every attempt with its full `tool_input`. The worker
then reports honestly: *"I created both files, but I couldn't run the test — both attempts
to execute python3 were blocked pending approval and declined."*

So the worker advertises Bash, spends turns calling it, and never gets it. MEMORY.md
recorded the symptom during v0.1 ("Bash was declined in its headless sandbox") but it was
read as a sandbox quirk rather than a permission-mode consequence, so it was never fixed.

**Why it matters beyond v1.** `specs/v2-architecture.md` derives `ValidationStarted` /
`ValidationCompleted` from Bash commands matching a test-runner pattern, and Phase F's
checkpoint reports `validationPending`. On the current arguments those events can **never**
reach a successful state — v2 would ship machinery for a path that cannot succeed.

## Approach

**Verified fix** (same stack, same prompt, one flag added — `tests/fixtures/streams/allowed.ndjson`):

```
claude -p … --permission-mode acceptEdits --tools Read,…,Bash --allowedTools "Bash(python3 *)"
```

→ `permission_denied` events: **0**; tool_result `is_error: false`, content `"test passed"`.

So `glm-worker` gains `--allowedTools` built from a config-driven allowlist of Bash command
patterns:

```json
"worker": {
  "maxTurns": 20,
  "allowedBash": ["npm test", "npm run *", "npx vitest *", "go test *",
                  "pytest*", "python3 *", "cargo test*", "git status", "git diff*"]
}
```

- Default list covers **validation commands only** — the things a worker needs to prove its
  own work. It deliberately excludes `git commit` / `git push` (AGENTS.md: no automatic git
  commits), `rm`, `curl` / `wget`, `sudo`, and package installs.
- `worker.allowedBash: []` restores today's behavior *honestly*: Bash is then also dropped
  from `--tools`, so the worker stops wasting turns on a tool it cannot use.
- `--no-bash` on the command line forces the empty case for one run.
- `glm-review` is unaffected — it has no Bash in `--tools` and must not gain one.

**Rejected: `--permission-mode bypassPermissions`.** It is `--dangerously-skip-permissions`
under a different name, and AGENTS.md forbids that flag for the worker. It would let the
worker run anything, which is a strictly larger change than this defect requires.

**Honest limits — this is a guardrail, not a sandbox.** A pattern like `Bash(python3 *)`
still permits `python3 -c "<anything>"`. The allowlist prevents *accidents and scope creep*,
not a determined prompt injection. It is also a real capability increase: a worker that can
already Write any file gains the ability to execute what it wrote. That trade is the whole
point of a delegation worker, and it is the reason the list ships conservative, is visible
in `config show`, and can be emptied in one setting.

## Scope

- `src/bin/glm-worker.ts` — `buildWorkerArgs` appends `--allowedTools`, or drops `Bash` from
  `--tools` when the list is empty; `--no-bash` flag parsing.
- `src/core/config.ts` — `worker.allowedBash: string[]` with the default list, zod-validated
  (non-empty strings; reject patterns containing `&&`, `;`, `|` — they defeat the matcher).
- `src/mcp/server.ts` — `glm_worker` inherits the same args (it calls `buildWorkerArgs`).
- `src/commands/doctor.ts` — a line showing how many Bash patterns are allowed.
- Tests: `tests/unit/worker-args.test.ts` (default list → flag present; empty list → no Bash
  in `--tools` and no `--allowedTools`; `--no-bash`; rejected patterns → `ERROR [11]`);
  the fake-agent env dump already captures argv, so the integration assertion is cheap.
- Docs: README (what the worker may execute), AGENTS.md hard-rule bullet, MEMORY.md.

**Out of scope:** per-project allowlists, an interactive approval bridge, MCP
`permission_prompt_tool` wiring, changing `glm-review`.

## Acceptance criteria

- [ ] Default config: a worker asked to run `python3 test_x.py` executes it, and the stream
      contains **zero** `permission_denied` events.
- [ ] `worker.allowedBash: []`: `--tools` no longer contains `Bash` and no `--allowedTools`
      is passed.
- [ ] `--no-bash` behaves as the empty list for that invocation.
- [ ] A pattern containing `&&`, `;` or `|` is rejected at config load with `ERROR [11]`.
- [ ] `glm-review`'s arguments are byte-identical to 1.0.0.
- [ ] Re-running the captured `edit.ndjson` scenario live produces a passing test run
      instead of two denials.
- [ ] `npm run build`, `npm test`, `npm run lint` green.

## Validation

```
npm run build && npm test && npm run lint
npx vitest run tests/unit/worker-args.test.ts

# Live (needs ZAI_API_KEY), in a scratch dir:
glm-worker "Create add.py with add(a,b), create test_add.py asserting add(1,2)==3, then run: python3 test_add.py"
# expect: the test actually runs; no "This command requires approval"
```
