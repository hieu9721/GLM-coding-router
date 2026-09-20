# Spec: v2 architecture — observability + quota-aware routing

Build spec for `docs/GLM Coding Router v2 — Observability & Quota-Aware Routing.md`.
The doc states *what* v2 is; this file states *how it is built here* — file by file,
phase by phase, with the contracts that must not break. Read the doc first; this spec
does not repeat its rationale.

## Problem

Three gaps in v1.0:

1. **Blind workers.** `glm-worker` / `glm-review` inherit stdio and print one blob at the
   end. The orchestrator (and the human) cannot see turns, tools, files touched, or that
   the run is alive at all. Nothing is recorded after the process exits.
2. **Quota-blind routing.** `glm-router usage` (v0.5) can *read* the Z.ai quota, but no
   code path *acts* on it. A run can start with 40 credits left, burn them mid-task and
   die with a dirty worktree and no summary.
3. **No handoff.** When GLM stops being viable, there is no structured way to give the
   task back to the parent Claude/Codex session.

## Approach

One canonical event stream feeds everything else:

```
claude.exe --output-format stream-json --verbose
        │ stdout (NDJSON)            │ stderr (retry notices)
        ▼                            ▼
   ClaudeEventAdapter  ──────────────┘        (pure, defensive, no throw)
        ▼
   WorkerEvent  ──►  EventBus  ──┬──►  RunStore      (events.jsonl / summary.json)
                                 ├──►  ProgressRenderer (stderr only)
                                 ├──►  CheckpointBuilder
                                 └──►  DrainController  (safe-boundary kill)
```

and one pure decision function gates every GLM spawn:

```
BudgetSnapshot (Z.ai monitor, cached)  ┐
CostEstimate   (history p90 | baseline)├──► decideRoute() ──► run | downgrade | return_to_parent
RouterConfig   (zones, reserve, safety)┘        (pure, table-tested)
```

In 2.0.0 the `return_to_parent` arm is built, tested and **off by default** (D3): the
shipped router observes, downgrades and warns, but never refuses a run and never kills a
live child. See "Decisions" at the bottom.

Four contracts hold the whole design together. **Every phase is checked against them:**

| # | Contract | Why |
|---|---|---|
| C1 | **stdout of `glm-worker` / `glm-review` stays exactly the final assistant text.** All progress, warnings and router chatter go to stderr. | v1 callers, shell pipes, and `benchmark` parse stdout. Doc §7, §23. |
| C2 | **The MCP server's stdout is never touched.** MCP tools run with the registry on and the renderer off. | stdout is the JSON-RPC channel (specs/v1-architecture.md). Doc §23. |
| C3 | **No secret, no full prompt, no source code, no LLM response body is ever persisted.** Events carry short, redacted summaries only. | AGENTS.md security rules, doc §6. |
| C4 | **v1 command surface is backward compatible.** Same args, same exit codes for the same situations; new behavior is additive or opt-out. | Doc §23. |

**Deliberate deviations from the doc** (rationale, not oversight):

- **Doc §9 (React + Ink).** Phase G ships `runs` / `watch` / `dashboard` line-oriented with
  a repaint loop and **zero new dependencies**, matching how v1.0's MCP server was
  hand-rolled rather than pulling in an SDK. `react` + `ink` add ~40 transitive packages to
  a CLI whose install footprint is currently 3 runtime deps. The renderer is isolated behind
  `src/tui/render.ts`, so swapping in Ink later is a contained change. *Decided 2026-09-20
  (D1) — accepted cost: the dashboard may flicker slightly on repaint.*
- **Doc §19 ("không stop giữa Edit").** Honest version: the router can only act on events it
  has already received, so DRAINING terminates the child immediately after a
  `ToolCompleted` / turn boundary. The window between that event and the child starting its
  next tool is small but non-zero; the design is *best-effort safe boundary*, and the
  handoff bundle always carries the real `git diff` so nothing is inferred from assumptions.
  Proactive draining is additionally **opt-in** in 2.0.0 (D3 below); the bundle itself is
  always written when a run dies, which is what actually protects the working tree.
- **`glm-review` is instrumented too.** The doc talks about the worker; review goes through
  the same spawn path, so excluding it would cost more code than including it.

## Scope

New directories (doc §22 → actual layout):

```
src/events/    types.ts  bus.ts  claude-adapter.ts
src/runs/      ulid.ts  registry.ts  store.ts  checkpoint.ts  heartbeat.ts  worker-run.ts
src/budget/    manager.ts  estimator.ts
src/routing/   glm-routing.ts
src/handoff/   bundle.ts  parent-handoff.ts
src/tui/       render.ts  progress.ts  watch.ts  dashboard.ts  runs-view.ts
src/commands/  runs.ts  watch.ts  dashboard.ts
```

Touched existing files: `src/core/config.ts` (v2 config sections), `src/core/paths.ts`
(run dirs), `src/core/errors.ts` (2 new codes), `src/core/process.ts`
(`spawnAgentStream`), `src/bin/glm-worker.ts` + `src/bin/glm-review.ts` (route through
`worker-run.ts`), `src/mcp/server.ts` (registry on / renderer off), `src/cli.ts` (3 new
commands), `src/templates/*` (teach orchestrators the handoff result), `package.json`
(version 2.0.0), `tests/fixtures/fake-agent.mjs` (stream emission).

**Out of scope for v2** (doc §2): Claude/Codex as workers, ZCode, role inversion, generic
provider SDK, multi-provider scheduler, parallel provider execution, cost-to-currency
conversion, MCP resources/prompts. (Cross-platform support is no longer on this list — it
ships first, as 1.1.0; see D6.)

---

## Phase A — Event model + Claude stream-json adapter

**A0 — DONE 2026-09-20.** Three fixtures were captured against the real stack (Claude Code
**2.1.278**, GLM-5.3 over the Z.ai endpoint, cost: 9 of 2000 credits) and live in
`tests/fixtures/streams/`: `basic.ndjson` (read-only, 52 lines), `edit.ndjson` (2 Writes +
2 Bash attempts, 111 lines), `allowed.ndjson` (the same Bash under `--allowedTools`,
77 lines). They are scrubbed — home paths, the installed-skill list, socket paths and
session UUIDs replaced with stable fakes — which also makes them deterministic test inputs.

**What the real stream showed, versus what this spec originally assumed.** Every item below
is a correction, not a confirmation; the schema really is not a stable public API:

| Reality | Consequence for the adapter |
|---|---|
| **`system/thinking_tokens` is 83–88% of all lines** (43 of 52; 94 of 111), each carrying `estimated_tokens` / `estimated_tokens_delta`. | Not noise to discard: it is a live token counter and the best "still alive" signal there is. Map it to a **throttled** liveness update (≤1/sec) for the renderer and the heartbeat. Never write one event per line to `events.jsonl` or the file would be ~85% counter spam. |
| **`assistant` messages carry exactly ONE content block**, not a mixed list — the run goes `thinking` → `tool_use` → `thinking` → `text`. 4 assistant messages for `num_turns: 2`; 7 for `num_turns: 5`. | **The original turn heuristic ("TurnStarted when an assistant message arrives") is wrong** and would have roughly doubled every turn count. Derive a turn from the `tool_result` → next `tool_use` cycle, and reconcile against `result.num_turns` at the end. |
| **`thinking` blocks contain raw model reasoning.** | C3: dropped at the adapter boundary, never summarized, never persisted. |
| **`system/hook_started` / `hook_response` appear** (user hooks fire inside the stream). | Recognized and ignored; they are neither tool activity nor errors. |
| **`system/permission_denied` exists**, with `tool_name`, `tool_use_id`, `decision_reason`. | A first-class outcome, not an error: new event `ToolDenied`. `result.permission_denials[]` carries the same list with the full `tool_input` for the summary. |
| **`result` is far richer than assumed**: `num_turns`, `duration_ms`, `duration_api_ms`, `ttft_ms`, `stop_reason`, `terminal_reason`, `permission_denials`, `modelUsage`, `usage` with cache-token breakdown, `subagent_stats`. | `RunCompleted` takes its numbers straight from here instead of tallying events. Classify with `subtype` + `terminal_reason`, not `subtype` alone. |
| **`session_id` is present on init and on every subsequent message.** | H3 confirmed — record it once from init. |
| **stderr carries structured diagnostics**, e.g. `[claude-code:unrecognized_model] {"model":"glm-5.3[1m]",…}`, emitted on normal successful runs. | The stderr sink must **not** classify these as `ApiRetry`. Match retry text explicitly; everything else is a passthrough diagnostic. |

**The trap — `total_cost_usd` must not be used.** The result carries
`total_cost_usd: 0.0154` and `modelUsage: { "glm-5.3": { costUSD: 0.0154, contextWindow:
200000, provider: "firstParty", … } }`. Claude Code computed that by applying **Anthropic's
price table and its own defaults to a model it does not know** — the same wrongness that
`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` already works around for the
context window. GLM bills in plan credits, not dollars. The field looks authoritative and is
fiction for this stack. **Phase E's estimator ignores it; the quota delta stays the only
truth.** The *token* counts in `modelUsage` are real (they come from the API response) and
may be used.

**`src/events/types.ts`** — the canonical union (doc §4). Every event carries the **H1**
envelope `{ runId, taskId, provider, role, seq, ts }`; `seq` is assigned by the bus, monotonic
per run, and `taskId` defaults to the `runId` while there is no task graph. `provider` is the
canonical id `zai.zcode` (**H2**, settled by D5) — `"GLM"` is display text only and never
reaches a persisted event. `role` is `"worker"` or `"reviewer"`.

> The envelope is per-event and therefore also per-file in `events.jsonl`, which is the whole
> point of H1: a v2-era history stays readable by v3/v4 without a migration pass.

| Event | Payload beyond the envelope |
|---|---|
| `RunStarted` | `kind: "worker" \| "review" \| "delegate"` (which CLI surface — the vendor id lives in the envelope per H2), `model`, `cwd`, `taskTitle`, `taskHash`, `parent: {type: "claude" \| "codex" \| "shell"}` |
| `AgentInitialized` | `sessionId`, `model`, `tools: string[]` |
| `TurnStarted` | `turn: number` |
| `ToolStarted` | `turn`, `toolUseId`, `tool`, `summary` (≤120 chars, redacted) |
| `ToolCompleted` | `turn`, `toolUseId`, `tool`, `ok: boolean`, `durationMs` |
| `FileChanged` | `turn`, `path` (repo-relative), `op: "edit" \| "write"` |
| `ValidationStarted` / `ValidationCompleted` | `turn`, `command` (≤120 chars), and on completion `ok`, `durationMs` |
| `ToolDenied` | `turn`, `toolUseId`, `tool`, `reason` (from `system/permission_denied`) |
| `ApiRetry` | `attempt?`, `reason` (stderr line, truncated) |
| `BudgetWarning` | `zone`, `remainingRatio`, `usableBudget`, `estimatedRemaining` |
| `CheckpointCreated` | `path`, `phase` |
| `HandoffStarted` / `HandoffCompleted` | `reason`, and on completion `bundlePath` |
| `RunCompleted` | `turns`, `durationMs`, `filesChanged`, `tokensIn`, `tokensOut`, `costCredits?` |
| `RunFailed` | `reason` (`error_max_turns` \| `child_error` \| `adapter_error` \| …), `exitCode` |
| `RunCancelled` | `signal` |
| `Heartbeat` | `state`, `turn` |

**`src/events/bus.ts`** — ~40 lines: `createEventBus(runId, { taskId?, role })` with
`emit(event)` (stamps the whole H1 envelope), `subscribe(fn)`, `close()`. Synchronous dispatch, subscriber exceptions are
caught and logged at debug level (a broken renderer must never kill a run).

**`src/events/claude-adapter.ts`** — two exports:

- `adaptClaudeMessage(raw: unknown, state: AdapterState): WorkerEvent[]` — pure. Maps
  `system/init` → `AgentInitialized`; `assistant` messages → `TurnStarted` (when the turn
  counter advances) + one `ToolStarted` per `tool_use` block; `user` messages carrying
  `tool_result` → `ToolCompleted` (+ `FileChanged` for Edit/Write/MultiEdit that returned
  ok, + `ValidationCompleted` when the matching `ToolStarted` was a validation);
  `result` → `RunCompleted` or `RunFailed` by `subtype`.
- `createStreamAdapter()` — wraps it with NDJSON line buffering (partial chunks, `\r\n`,
  blank lines) and a stderr sink producing `ApiRetry`.

Rules: **never throw** — an unrecognized `type`, a missing field, or invalid JSON produces
zero events plus one debug log. `summary` derivation per tool: Read/Edit/Write → path made
repo-relative; Bash → command, first line, truncated; Grep/Glob → pattern; anything else →
tool name only. Every summary passes through `redact()` before it leaves the adapter.
Validation detection: Bash command matches `/(npm|pnpm|yarn) (run )?(test|lint|typecheck)|vitest|jest|go test|pytest|cargo test|tsc\b|python3? (-m (pytest|unittest)\b|\S*test\S*\.py)/`.

> The `python3` arm was added on 2026-09-20 when the adapter landed: A0's captured runs
> validate with `python3 test_add.py`, which the original pattern missed, so **not one of
> the three fixtures exercised the validation path** and the spec's own "a denied validation
> is a real, reportable outcome" described something that could not happen. The allowlist in
> `specs/worker-bash-permissions.md` already treats `python3 *` and `pytest*` as validation
> commands; this makes the detector agree with it.

**Prerequisite — `specs/worker-bash-permissions.md`.** A0 proved that on the published 1.0.0
arguments *every* Bash call is denied (`system/permission_denied`, "This command requires
approval"), so `ValidationCompleted` could never reach a successful state and Phase F's
`validationPending` would describe a path that cannot exist. That defect is fixed in 1.1.0
alongside cross-platform support; v2 depends on it. Until then the validation events are
still emitted — a denied validation is a real, reportable outcome — but the green path only
becomes reachable with the `--allowedTools` fix.

**Tests:** `tests/unit/claude-adapter.test.ts` — replay each captured fixture, assert the
exact event sequence; feed split-mid-JSON chunks; feed garbage lines, unknown message
types, and a truncated stream, asserting no throw and no stray events.

---

## Phase B — Run identity, registry, store

**`src/runs/ulid.ts`** — ~30 lines, `crypto.randomBytes`, Crockford base32, monotonic
within a process. `runId = "run_" + ulid()` (doc §5). No dependency.

**`src/core/paths.ts`** additions: `runsDir(home)`, `activeRunsDir(home)`,
`runHistoryDir(home, date)`, `runDir(home, date, runId)` under
`<configDir>/runs/{active,history/YYYY-MM-DD/<runId>}` (doc §6).

**`src/runs/registry.ts`** — `createRun(meta)` writes `active/<runId>.json` (doc §5
metadata + `pid`, `heartbeatAt`, `state`); `updateRun(runId, patch)` atomic rewrite;
`finishRun(runId, summary)` writes `summary.json` into the history dir and deletes the
active file; `listActive()` / `listHistory(filter)`; `pruneHistory(config.history)`
enforcing `retentionDays` and `maxRuns` (oldest first), called opportunistically at run
start and by `runs clean`.

**`src/runs/store.ts`** — opens `events.jsonl` in the history dir at run start (the run
directory is created immediately, not at the end, so `watch` can attach), appends one JSON
line per event, `flush()`/`close()`. Append-only: a crashed run leaves a readable
`events.jsonl` and no `summary.json`. `readEvents(runDir)` reconstructs; `summarize(events)`
rebuilds a summary from events so `runs show` works for crashed runs.

**`src/runs/heartbeat.ts`** — `startHeartbeat(runId, getState)` emits a `Heartbeat` event
and refreshes `heartbeatAt` every 5 s (config-free constant). A reader treats an active run
as **orphaned** when `heartbeatAt` is older than 30 s *and* `process.kill(pid, 0)` throws;
`runs clean` moves orphans to history with **state `FAILED`** and a summary rebuilt from
`events.jsonl`. (This said `status: "orphaned"` until Phase G was built: `RunState` uses
v4 §21's names per hedge H6 and has no `orphaned` member, and inventing one would have
undone that hedge for a single bookkeeping case. "Orphaned" stays a *detection* result
(`isOrphaned`) and a dashboard marker, not a persisted state.)

**C3 enforcement (test it, don't assume it):** what goes on disk is the metadata above plus
canonical events. `taskTitle` = first line of the prompt, ≤120 chars, redacted;
`taskHash` = sha256 of the full prompt (used by the estimator, reveals nothing). Never the
prompt body, never tool inputs beyond the ≤120-char summary, never tool results, never env.

**Tests:** `tests/unit/ulid.test.ts` (sortability, uniqueness, monotonic within a ms);
`tests/unit/run-registry.test.ts` in a temp home — lifecycle, orphan detection with a dead
pid, pruning by both limits, summary reconstruction from `events.jsonl` alone, and an
assertion that no file under `runs/` contains a planted fake key or the prompt body.

---

## Phase C — Progress renderer (stderr)

**`src/tui/render.ts`** — writer abstraction over an injectable stream + `isTTY` +
color on/off. All ANSI lives here.

**`src/tui/progress.ts`** — `attachProgress(bus, {mode, stream})`, three modes (doc §7):

- `rich` — the box header + per-turn tree, redrawn in place. Only when `stream.isTTY`.
- `nested` — one `[GLM] …` line per significant event, no cursor control. Used when stderr
  is not a TTY (the orchestrator case) or `GLM_ROUTER_NESTED=1`.
- `off` — renders nothing.

Resolution order: `--no-progress` / `--quiet` / `CI=true` / `GLM_ROUTER_PROGRESS=off` → `off`;
else `ui.mode` from config (`auto` default) → `rich` if TTY else `nested`.
Final `RunCompleted` footer: duration, turns, files (doc §7).

**C1/C2 enforcement:** `attachProgress` takes its stream as a parameter and the production
callers pass `process.stderr`. A unit test asserts that a full event replay writes **zero
bytes** to the injected stdout stream in all three modes.

**Tests:** `tests/unit/progress-renderer.test.ts` — replay a fixture into each mode with a
non-TTY memory stream; snapshot the nested output; assert stdout untouched; assert mode
resolution for the flag/env/TTY matrix.

---

## Phase D — Instrumented worker run (wiring A+B+C)

**`src/core/process.ts`** gains `spawnAgentStream(binPath, {args, cwd, env, onStdoutLine,
onStderrLine, onSpawn})` → `Promise<{code: number}>`: pipes both streams, splits lines,
reuses the existing `forwardSignals` helper, and exposes the child (via `onSpawn`) so the
drain controller in Phase F can terminate it. Same no-shell, argv-array rule.

**`src/runs/worker-run.ts`** — the single orchestration path used by `glm-worker`,
`glm-review` and the MCP tools:

1. resolve config/profile/key/claude path (unchanged v1 code),
2. **preflight** (Phase E) — may downgrade the model or refuse,
3. `createRun` + bus + store + progress + heartbeat,
4. spawn with the v1 args **plus** `--output-format stream-json --verbose`,
5. feed stdout lines through the adapter into the bus; stderr lines through the retry sink
   **and** to the renderer's passthrough (so real Claude errors stay visible),
6. on `RunCompleted`: write the `result` text to **stdout** (C1), `finishRun`, record a cost
   sample (Phase E),
7. exit code: 0 on success, 40 on child failure / `error_max_turns` (unchanged from v1),
   41/42 on the new quota paths (Phase E/F).

**Legacy escape hatch (C4):** if the caller already passed `--output-format` (as
`benchmark` does with `json`), or `GLM_ROUTER_OBSERVE=off` is set, `worker-run` falls back
to the exact v1 `spawnAgent` inherit path — no registry, no adapter, byte-identical
behavior. `benchmark` therefore keeps working untouched in this phase.

**MCP (C2):** `callMcpTool` passes `{progress: "off", registry: true}`, so MCP-driven runs
appear in `runs`/`dashboard` while the protocol channel stays clean.

**`tests/fixtures/fake-agent.mjs`** learns two env vars: `GLM_TEST_STREAM` (path to an
NDJSON file whose lines are written to stdout, one per `GLM_TEST_STREAM_DELAY_MS`,
default 0) and `GLM_TEST_STDERR` (lines to emit on stderr). Existing behavior is unchanged
when they are absent.

**Tests:** `tests/integration/worker-run.test.ts` — fake agent replays a captured stream;
assert stdout is *exactly* the final text, the run dir contains `events.jsonl` +
`summary.json` with the right turn/file counts, progress went to stderr only, exit codes
map correctly, and the legacy path is chosen when `--output-format` is passed.

---

## Phase E — Budget manager, estimator, preflight routing

**`src/budget/manager.ts`** — built on v0.5's `fetchZaiQuota`:

```ts
interface BudgetSnapshot {
  provider: "zai.zcode";   // canonical id (H2/D5) — "GLM" is display text only
  fiveHour: BudgetWindow;   // { used, limit, remaining, remainingRatio, resetAt }
  weekly:  BudgetWindow;
  confidence: "exact" | "cached" | "unknown";
  fetchedAt: string;
}
```

Mapping: `unit 3` → `fiveHour`, `unit 6 & number 1` → `weekly` (specs/usage.md).
Cached in `<configDir>/cache/quota.json` with a 60 s TTL so a burst of runs makes one
request; `--refresh-quota` bypasses it. **Fail-open:** endpoint down / malformed / no key →
`confidence: "unknown"`, and every downstream decision degrades to "run normally, warn
once on stderr". A monitoring outage must never block work.

`zoneFor(snapshot, thresholds)` uses `min(fiveHour.remainingRatio, weekly.remainingRatio)`
→ `HEALTHY | CONSERVE | HANDOFF_READY | CRITICAL` (doc §11 defaults, config-overridable).

**`src/budget/estimator.ts`** (doc §13):

- `classifyTask(prompt)` → `"explore" | "crud" | "tests" | "docs" | "refactor" | "bugfix" | "other"`,
  a deterministic keyword classifier (unit-tested table, not a model call).
- Samples live in `<configDir>/cost-samples.jsonl`:
  `{ ts, taskKind, model, repo, credits, turns, tokensIn, tokensOut }`.
- A sample is recorded at run end **only when the measurement is clean**: quota snapshot
  taken at start and end, the same 5-hour window (no `nextResetTime` change), delta ≥ 0,
  **and this run was the only active run in the registry** — concurrent runs make credit
  attribution meaningless, so those runs record nothing.
- `estimateCost(taskKind, model)` → `{ p50, p90, samples, source: "history" | "baseline" }`,
  using history when `samples >= 5`, else the baseline table in code (doc §13:
  backend CRUD on main ≈ p50 42 / p90 66; one row per kind × {main, fast}).
  Preflight always uses **p90**.

**`src/routing/glm-routing.ts`** — one pure function, the heart of the phase:

```ts
decideRoute({ snapshot, estimate, config, requestedModel, force })
  → { action: "run" | "downgrade" | "return_to_parent",
      model, zone, reason, usableBudget, estimatedCost,
      wouldRefuse: boolean }   // the refusal the router *would* have made
```

- `reserve = reserveRatio × limit`; `usableBudget = remaining − reserve` (doc §11).
- `wouldRefuse = true` when `estimate.p90 × safetyFactor > usableBudget` for **both** main
  and fast (doc §14: always try Flash before giving up), or when the zone is CRITICAL.
- Zone → model preference (doc §12): HEALTHY → main; CONSERVE / HANDOFF_READY → fast.
- **`wouldRefuse` becomes `action: "return_to_parent"` only when
  `routing.refuseOnCritical` is true — which is NOT the default in 2.0.0 (D3).** With the
  default, the router logs a `BudgetWarning`, prints one stderr line, and runs anyway on the
  preferred model.
- `--model main|fast` pins the model but does **not** bypass an enforced refusal; `--force`
  does, with a stderr warning.
- `confidence: "unknown"` → always `action: "run"` with the requested model.

**Why the switch exists (D3).** The refusal arithmetic is only as good as its input, and
with no `cost-samples.jsonl` yet the estimator falls back to a **baseline table transcribed
from doc §13 that has never been measured on this machine** — unlike the quota endpoint,
which v0.5 verified live before anything was designed on top of it. A baseline that reads
high turns into refusals of runs the quota could actually have afforded, and the user only
finds out by discovering `--force`. Downgrading to Flash carries no such risk, so it stays
on; refusing does not.

**Evidence for flipping the default in 2.1 — build it now, it is nearly free.** Every
`summary.json` records `routingAdvice: { wouldRefuse, estimatedCost, usableBudget, zone,
actualCredits }`. After a few weeks, `glm-router runs --json` answers the only question that
matters: *how often would the refusal have been wrong?* Compare `wouldRefuse: true` against
the `actualCredits` that run really consumed. Flip `refuseOnCritical` to default-true in 2.1
when the false-refusal rate is acceptable — not before.

**Preflight refusal output** (doc §14, §18), emitted when the refusal is *enforced* — stderr
gets the human `[Router]` block, stdout gets one `HandoffResult` JSON:

```json
{ "status": "handoff_required", "run_id": "run_…", "reason": "quota_insufficient",
  "completed": [], "pending": ["<taskTitle>"], "handoff_path": null,
  "estimated_cost": 90, "usable_quota": 50 }
```

exit code **41 `QUOTA_INSUFFICIENT`**. Nothing is spawned, nothing is written to the repo.

**New in `src/core/errors.ts`:** `ExitCode.QuotaInsufficient = 41`,
`ExitCode.HandoffRequired = 42`, with `Errors.quotaInsufficient()` /
`Errors.handoffRequired()` in the standard `ERROR [NAME]` format. AGENTS.md's exit-code
bullet gains these two.

**Tests:** `tests/unit/budget-manager.test.ts` (window mapping from the real payload shape,
cache TTL, all three confidence levels), `tests/unit/glm-routing.test.ts` (table-driven over
zones × estimates × overrides — this is the cheapest place to be exhaustive),
`tests/unit/estimator.test.ts` (classifier table, p50/p90 math, baseline fallback, the
"only active run" and "window reset" sample-rejection rules),
`tests/integration/preflight.test.ts` (**both** switch positions: with `refuseOnCritical:
true` an injected low quota → exit 41 + JSON on stdout + no spawn; with the 2.0.0 default →
the child **is** spawned, exit 0, and `wouldRefuse: true` is recorded in `summary.json`;
downgrade path asserts the fast model in the child env).

---

## Phase F — Draining, checkpoint, handoff bundle

**Drain controller** (in `worker-run.ts`, logic in `src/runs/drain.ts`):

- While running, re-read the budget every `routing.pollIntervalSec` (default 60).
- When `zoneFor()` ≤ HANDOFF_READY **and** the remaining-cost projection
  (`estimate.p90 × safetyFactor × remainingTurnRatio`) no longer fits `usableBudget`:
  emit `BudgetWarning` and write a checkpoint. **This always happens** — it is observation,
  it costs nothing and it interrupts nobody.
- **Terminating the child is gated on `routing.handoffOnLowQuota`, default false in 2.0.0
  (D3).** When enabled: set state `DRAINING` (doc §20), then at the next `ToolCompleted` or
  turn boundary emit `CheckpointCreated` and stop the child — SIGINT, 5 s grace, then
  SIGTERM (Windows: `taskkill /pid <pid> /t` as the last resort, consistent with the
  existing spawn rules). State goes CHECKPOINT → HANDOFF (doc §20). `RunCancelled` is never
  used for this path; handoff is a distinct, successful-ish outcome.
- **The bundle is written whenever a run dies with work on disk, switch or no switch.** If
  quota runs out for real, the child fails on an API error and exits non-zero — at that
  point the work is already lost to the orchestrator unless someone writes it down. So on
  *any* terminal state that is not a clean success and where at least one `FileChanged`
  was seen, `worker-run` builds the full handoff bundle and prints its path to stderr.
  The exit code in that case stays **40** (`CHILD_AGENT_FAILED`, unchanged from v1 — C4);
  only the proactive, router-initiated handoff uses 42. This is what actually satisfies
  doc §23's "không mất working tree changes", and it holds with every switch off.

**`src/runs/checkpoint.ts`** — `buildCheckpoint(events, git)` → doc §16 shape:
`phase` (derived: exploration / implementation / validation, from the tool mix of the last
turn), `completed` (one line per completed turn, from tool summaries), `pending`
(the task's remaining intent — derived from the prompt's checklist lines if present, else a
single "continue the task" entry), `filesChanged` (from `FileChanged`), `validationPending`
(validation commands that started but never completed, plus validations that failed).
Written to `checkpoint.json` in the run dir. Rebuilt from events only — the worker is never
asked to write its own summary (doc §17).

**`src/handoff/bundle.ts`** — writes into `<runDir>/handoff/`:

- `checkpoint.json` (above),
- `diff.patch` — `git diff` (tracked changes) in the run's cwd,
- `handoff.md` — task title, run id, reason, what was done, what remains, files changed,
  **untracked files listed separately** (they are *not* in `diff.patch`; the router never
  runs `git add`, per the no-automatic-git rule), validation still owed, next step,
- `handoff.json` — the machine-readable twin, the doc §18 shape plus `bundle` paths.

Not a git repo → the bundle is still written, `diff.patch` is omitted and `handoff.md` says
so. Bundle writing must never fail the run: an error there is logged and the JSON still
goes to stdout.

**`src/handoff/parent-handoff.ts`** — prints the `HandoffResult` JSON to stdout, the human
summary to stderr, returns exit code **42 `HANDOFF_REQUIRED`**.

**Orchestrator-facing docs (required, not optional).** Exit 42 is meaningless if Claude and
Codex read it as "the worker crashed". Update in the same phase:
`src/templates/claude-block.ts`, `src/templates/agents-block.ts` and
`src/templates/glm-delegation-skill.ts` gain a short section: *a worker may return
`status: "handoff_required"` on stdout with exit 41/42; read `handoff_path`, continue in the
same worktree, do not re-run the worker until quota resets.* `project init` / `skill install`
then propagate it (both are idempotent, so re-running is the upgrade path).

**Tests:** `tests/unit/checkpoint.test.ts` (event replay → checkpoint shape, including a
failed validation and a mid-turn stop), `tests/unit/handoff-bundle.test.ts` (temp git repo
with tracked + untracked changes → patch content, untracked list, non-repo fallback),
`tests/integration/drain-handoff.test.ts` (fake agent streams a long run while an injected
budget source drops into HANDOFF_READY → assert: stop happened on a `ToolCompleted`
boundary, bundle exists, stdout is the handoff JSON, exit 42, and the worktree still holds
the edits the fake agent made).

---

## Phase G — TUI commands

All line-oriented, no new dependency, every command supports `--json` (C4: machine output
stays first-class).

- `glm-router runs [--active] [--limit N] [--json]` — table: id, state, kind, model, started,
  duration, turns, files, cwd.
- `glm-router runs show <id>` — metadata + checkpoint + per-turn tool tree + handoff pointer.
- `glm-router runs logs <id> [--follow]` — raw `events.jsonl`, rendered or `--json` raw.
- `glm-router runs clean [--older-than 30d] [--orphans] [--dry-run]` — prunes history,
  reaps orphaned active files. `--dry-run` per repo convention.
- `glm-router watch [run-id]` — attaches to an active run (the newest when the id is
  omitted): reads `events.jsonl` from the current offset, follows with `fs.watch` +
  offset re-read (no polling loop when the platform delivers events), renders through the
  same `src/tui/progress.ts` as a live run. No active run → an explicit message, exit 0.
- `glm-router dashboard [--interval 2]` — full repaint every interval: quota (both windows +
  zone), active runs, recent runs, current model, errors (doc §8). `q` / Ctrl+C exits and
  restores the cursor. Non-TTY → prints one snapshot and exits (so it is pipeable and
  testable).

**Tests:** `tests/integration/runs-command.test.ts` (fabricated history in a temp home:
listing, show, logs, clean with both filters, `--dry-run` changes nothing, `--json` shapes),
`tests/integration/watch-command.test.ts` (append events to a live file, assert the render
follows and exits cleanly), `tests/integration/dashboard-command.test.ts` (non-TTY snapshot
with an injected budget source).

---

## Config v2

Added to `ConfigSchema` (`src/core/config.ts`) as **defaulted** sections, so every existing
v1 config still validates and `schemaVersion` stays `1` (zod strips unknown keys, so a v2
config read by a v1 binary also degrades quietly):

```json
{
  "routing": {
    "quotaAware": true,
    "refuseOnCritical": false,
    "handoffOnLowQuota": false,
    "reserveRatio": 0.10, "safetyFactor": 1.3,
    "preferFlashBelow": 0.30, "handoffReadyBelow": 0.15, "criticalBelow": 0.08,
    "pollIntervalSec": 60, "quotaCacheTtlSec": 60
  },
  "history": { "retentionDays": 30, "maxRuns": 1000 },
  "ui": { "mode": "auto", "color": true }
}
```

Ratio fields are validated as `0 < x < 1` and ordered (`criticalBelow < handoffReadyBelow <
preferFlashBelow`); a violating config is `ERROR [11]` like any other invalid config.

**Three switches, deliberately separate** (D3) — they differ in how much damage a wrong
decision does:

| Key | Default | What it gates | Why that default |
|---|---|---|---|
| `quotaAware` | `true` | Reading quota at all: model preference, `BudgetWarning`, checkpoints, `routingAdvice`. | Cheap and reversible. The worst case is a downgrade to Flash on a task that did not need it. |
| `refuseOnCritical` | **`false`** | Turning `wouldRefuse` into an actual exit 41. | Depends on an unmeasured baseline table; a wrong refusal blocks real work and hides behind `--force`. Flip in 2.1 on the evidence `routingAdvice` collects. |
| `handoffOnLowQuota` | **`false`** | Killing a *live* child at a safe boundary to hand off. | The most invasive action v2 can take, and the same unmeasured arithmetic drives it. Bundle-on-death (Phase F) already protects the working tree without it. |

`quotaAware: false` turns all three off and leaves pure observability — one switch for
anyone who wants v2 to be strictly additive over v1.

## Forward compatibility with v3 / v4

Read `docs/GLM Coding Router v3 …` and `docs/AI Coding Router v4 …` before Phase A. v2 must
not *build* their abstractions — a provider SDK written for one provider guesses wrong — but
v2 is the release that starts **writing files that outlive it**: `events.jsonl`, `summary.json`,
`cost-samples.jsonl`, `handoff.json`. A field missing from those cannot be backfilled later,
because the history simply does not exist. That asymmetry decides what is hedged here.

**The hedges — all cheap now, expensive or impossible later:**

| # | Hedge | Phase | What it buys in v3/v4 |
|---|---|---|---|
| H1 | Event envelope is `{ runId, taskId, provider, role, seq, ts }`, not `{ runId, seq, ts }`. `taskId` defaults to the `runId` while there is no task graph; `role` is `"worker"` or `"reviewer"`. | A | v3 §16 TaskGraph groups runs; v4 §33 unifies events across providers. Without it, every v2-era `events.jsonl` needs a migration pass to be readable. |
| H2 | Persist the **canonical provider id**, not `"glm"` — v3 §1 fixes `zai.zcode`. Keep `"GLM"` as display text only. | A, B | v3 routes by provider id. A history full of `"glm"` forces a special case in the provider registry forever. Settled by D5: `zai.zcode`. |
| H3 | Record `sessionId` from the stream's `system/init` event into run metadata. | A, B | v3 §7 lists `nativeResume` via session id as a ClaudeCodeProvider capability. Costs one field; turns a future handoff from "restart the task" into "resume the session". |
| H4 | `cost-samples.jsonl` records `provider`, `role`, `validationOk`, `retries`, `costClass` alongside the v2 fields. | E | **The highest-value hedge.** v4 §17–18 route on rolling per-provider success rates ("ZCode Flash: success 96%, median 35s"). That table is built from exactly this file. Ship v2 without `validationOk` and v4's adaptive routing starts from zero history on the day it ships. |
| H5 | `handoff.json` carries v3 §17's `from: {provider, role}` / `to: {provider, role}` and v4 §20's `workspace: {repo, worktree, branch}` block from the start. | F | v3 §18's same-workspace principle and cross-provider handoff read exactly these fields. Bundles written by v2 stay valid instead of being a dead format. |
| H6 | Use v4 §21's state names where they overlap: `ROUTING` (not PREFLIGHT), `CHECKPOINTING` (not CHECKPOINT), plus `VERIFYING`/`COMPLETED`/`FAILED`/`CANCELLED`. | B, D, F | States are persisted in `summary.json`. Free to get right now, a translation table later. |
| H7 | `BudgetSnapshot` gains `unit: "credit"` and `costClass: "subscription"`. | E | v3 §21 and v4 §29 forbid silently escalating subscription → pay-as-you-go. That policy can only be enforced if the cost class was recorded when the spend happened. |
| H8 | The Claude stream parser implements a small `EventAdapter` interface (`{ onStdoutLine, onStderrLine } → WorkerEvent[]`); the bus, store and renderer depend on the interface, never on Claude's shapes. | A, C, D | v3 §8 adds `codex exec --json` as a second adapter. With H8 that is one new file; without it, it is surgery on the store and the renderer. |

**Explicitly NOT hedged** — building these for a single provider would encode today's
assumptions as tomorrow's constraints:

- No `CodingProvider` / `AgentProvider` SDK, no provider registry, no manifests (v3 §5, v4 §4–7).
- No role engine, no `AgentRole` type, no role config, no `roles`/`routes` commands (v3 §3, §11–13).
- No TaskGraph, scheduler, execution leases, workflows, policy engine (v3 §15–16, v4 §10–15).
- No generalized budget windows — GLM's 5-hour/weekly pair is concrete and v2 should say so;
  v3 widens it behind H7's `unit`/`costClass`.
- **No new MCP tools.** v3 §26 renames the surface to `agent_*` and v4 §22 to `coding_*`, both
  keeping the `glm_*` names as aliases. Any `glm_runs` / `glm_dashboard` tool added in v2 would
  be a third name to alias forever. `runs` and `dashboard` stay CLI-only.
- No YAML config (v3 §29, v4 §15 show YAML; v2 keeps zod-validated JSON — the shape is what
  those sections actually constrain, not the syntax) and no package rename (v4 §38 defers it).

## Implementation order

Phases are dependency-ordered and each one ends green (`build` + `test` + `lint`) and is
independently shippable:

```
[1.1.0 — specs/cross-platform.md + specs/worker-bash-permissions.md
         green suite on Linux AND Windows; the worker's Bash actually runs]
      ↓
A (events + adapter)  →  B (registry/store)  →  C (renderer)  →  D (instrumented run)
      ↓
E (budget + estimator + preflight)  →  F (drain + checkpoint + handoff)  →  G (TUI)
```

**Releases (D4): two, after a prerequisite.** **1.1.0** ships first — cross-platform support
per `specs/cross-platform.md`, so the build machine has a green suite before v2 adds 40 new
tests to it. Then **2.0.0-beta.1** after Phase D — observability complete, routing
untouched, so the beta is judged on one question only ("does instrumenting the worker break
anything?"). Run it as the daily driver for about a week; that week is also what seeds
`cost-samples.jsonl`, which is what Phase E's estimator needs and what D3's 2.1 decision
will be argued from. Then **2.0.0** after Phase G + docs.

Each publish repeats the registry verification ritual in MEMORY.md (clean temp prefix, real
`glm-worker` run, `dist/` compared byte-for-byte against a rebuild of the tagged commit) —
and the owner publishes by hand because of 2FA, which is exactly why this is two rounds and
not three.

## Acceptance criteria

Doc §23's checklist, each mapped to how it is proven:

- [ ] **Run ID** — `glm-worker` prints `run_…` in the header; `runs` lists it; `events.jsonl`
      exists for it. *(integration: worker-run)*
- [ ] **Realtime progress** — turns and tools appear on stderr while the child is alive
      (fake agent with `GLM_TEST_STREAM_DELAY_MS=50`), not only at exit. *(integration)*
- [ ] **Dashboard works** — quota + active + recent render; non-TTY snapshot mode.
- [ ] **Watch attaches to an active run** — events appended after attach are rendered.
- [ ] **Run history exists** — `summary.json` + `events.jsonl` per run under
      `history/YYYY-MM-DD/`; retention prunes.
- [ ] **Quota realtime** — dashboard/preflight read the live monitor endpoint (cached ≤60 s);
      a real run against the real endpoint is part of release verification.
- [ ] **Main → Flash routing** — CONSERVE zone spawns the child with `models.fast` in
      `ANTHROPIC_DEFAULT_*` (asserted via the fake agent's env dump).
- [ ] **Preflight blocks an unaffordable run** — with `refuseOnCritical: true`: exit 41,
      handoff JSON on stdout, no child spawned, no repo writes.
- [ ] **Active run checkpoints** — `checkpoint.json` reflects completed/pending/files.
- [ ] **Quota-low run hands off to the parent** — with `handoffOnLowQuota: true`: exit 42,
      bundle with `handoff.md` + `handoff.json` + `diff.patch`, stop occurred on a safe
      boundary.
- [ ] **Shipped defaults never refuse and never kill (D3)** — with the 2.0.0 config, an
      injected CRITICAL quota still spawns the child, exits 0, warns once on stderr, and
      records `routingAdvice.wouldRefuse: true` in `summary.json`.
- [ ] **No working-tree changes lost** — proven twice: the drain test (switch on) asserts
      the fake agent's edits survive and appear in `diff.patch`; the **bundle-on-death**
      test (all switches off, child exits non-zero after a `FileChanged`) asserts the
      bundle is written anyway, exit stays 40, and the edits are on disk.
- [ ] **stdout compatibility (C1)** — `glm-worker "Reply exactly with V2_OK"` prints exactly
      `V2_OK`; `benchmark` still parses its JSON.
- [ ] **MCP stdout clean (C2)** — full tool-call suite over real stdio; every stdout byte is
      a valid JSON-RPC frame; stderr may carry anything.
- [ ] **v1 backward compatible (C4)** — the entire v1.0 test suite passes unmodified; the
      v1 exit codes still fire for the v1 situations.
- [ ] **Denied tools are reported, not swallowed** — replaying `edit.ndjson` yields two
      `ToolDenied` events and a summary that names the blocked commands.
- [ ] **`thinking_tokens` never floods the store** — replaying `edit.ndjson` (94 of 111 lines
      are counters) writes no more than a handful of liveness events to `events.jsonl`, and
      no `thinking` block text appears anywhere on disk.
- [ ] **No secret / prompt / source leaks (C3)** — a planted fake key and a distinctive
      prompt body appear in no file under `<configDir>/runs/` and in no rendered output.
- [ ] `npm run build`, `npm test`, `npm run lint` green; README + AGENTS.md + MEMORY.md
      updated; version 2.0.0.

## Risks

| Risk | Mitigation |
|---|---|
| Claude Code's `stream-json` schema drifts (it is not a stable public API) | Adapter never throws, unknown shapes are ignored; captured fixtures pin the version; `doctor` gains a check that runs `claude -p --output-format stream-json` once and reports whether the adapter recognizes the stream. |
| Stopping the child is not perfectly atomic (doc §19) | Only act on completed-tool boundaries; always ship the real `git diff`; document it as best-effort in `handoff.md`. |
| Credit deltas are wrong under concurrent runs | Cost samples recorded only when this run was the sole active run and no window reset intervened. |
| The unmeasured §13 baseline causes false refusals | D3: refusal and mid-run kill ship **off**; `routingAdvice.wouldRefuse` accumulates evidence against real `actualCredits` so 2.1 flips the default on data, not on the doc. |
| Quota endpoint outage blocks all work | Fail-open: `confidence: "unknown"` → run normally, warn once. |
| Progress output pollutes a machine-readable channel | C1/C2 asserted by tests that inject a stdout stream and require zero bytes. |
| `runs/` grows without bound | Retention (days + count) pruned at run start and by `runs clean`. |

## Validation

```
npm run build && npm test && npm run lint

# Phase A/D — adapter and stdout contract, no quota needed
npx vitest run tests/unit/claude-adapter.test.ts tests/integration/worker-run.test.ts

# Phase E/F — routing table + drain/handoff + bundle-on-death, injected budget
npx vitest run tests/unit/glm-routing.test.ts tests/integration/drain-handoff.test.ts

# D3 — the shipped defaults must not refuse and must not kill
npx vitest run tests/integration/preflight.test.ts -t "default"

# After ~a week on beta.1 — the evidence for flipping refuseOnCritical in 2.1
glm-router runs --json | jq '[.[] | select(.routingAdvice.wouldRefuse)] | length'

# Real-stack checks (need the key; run before each publish)
glm-worker "Reply exactly with V2_OK"     # stdout == V2_OK, run recorded
glm-router runs --limit 5
glm-router watch                          # in a second terminal during a real worker run
glm-router dashboard
glm-router usage                          # cross-check the dashboard's quota numbers
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"glm_worker","arguments":{"prompt":"Reply exactly with MCP_V2_OK"}}}' | node dist/bin/glm-mcp.js
```

## Decisions (locked 2026-09-20, owner)

| # | Decision | Consequence in this spec |
|---|---|---|
| D1 | **TUI is dependency-free.** No `react`/`ink`; all ANSI behind `src/tui/render.ts`, dashboard repaints on an interval. | Phase G as written. Accepted cost: slight flicker on repaint. Ink stays a contained future swap of one file, not a rewrite. |
| D2 | **Two exit codes: 41 preflight refusal, 42 mid-run handoff.** Both print a `HandoffResult` JSON on stdout. | Phase E/F as written. Obliges Phase F to update `claude-block.ts`, `agents-block.ts` and `glm-delegation-skill.ts` so orchestrators read 41/42 as "unfinished, bundle attached" rather than "crashed" — that doc work is not optional. |
| D3 | **`quotaAware: true`, but `refuseOnCritical: false` and `handoffOnLowQuota: false` in 2.0.0.** Observe and downgrade by default; never refuse, never kill. | Phase E/F code is built and tested in full, just not enabled. `routingAdvice` in every `summary.json` is the evidence for flipping the defaults in 2.1. |
| D4 | **Two releases: `2.0.0-beta.1` after Phase D, `2.0.0` after Phase G.** | The beta is judged on instrumentation alone, and the week it runs seeds `cost-samples.jsonl` for Phase E. Two manual 2FA publishes instead of three. |
| D5 | **Provider ids are vendor-first (v4 §5's scheme): `anthropic.claude-code`, `openai.codex`, `zai.zcode`.** v3 §1's `claude.code` mixed a product name into the vendor slot; vendor-first stays consistent when v4 §6 adds `google.gemini-cli`, `meta.ollama` and the rest. The product token stays `zcode` because v3 §9 defines that provider as the Z.ai *execution stack* — today reached through the Claude Code compatibility layer, later possibly through ZCode natively — while `glm-5.3` / `glm-5.3-flash` remain **model** names underneath it. | H2 is unblocked: Phase A/B write `"zai.zcode"` into every run record from the first run. `"GLM"` survives only as display text. **`docs/…v3….md` §1 needs updating to match**, or the two docs will keep disagreeing. |
| D6 | **Cross-platform support lands first, as 1.1.0.** Linux and macOS are no longer deferred; `specs/cross-platform.md` is the spec. | Phase A does not start until `npm test` is green on this Linux machine and on Windows. v2 inherits a trustworthy test signal instead of 15 permitted failures. |

Decided by the spec author, stated here so it is not silently re-litigated:

- **`glm-review` is instrumented too** — it shares the spawn path with `glm-worker`;
  excluding it would cost more code than including it.
- **v2 targets whatever `specs/cross-platform.md` supports** (D6). That spec ships as
  **1.1.0 before Phase A** and closes the v0.2 platform debt, because v2 is being built on a
  Linux machine where `npm test` is currently red — 15 failures that would otherwise be the
  background noise every new v2 test is judged against. v2 itself adds no platform-specific
  machinery: run directories come from `os.homedir()` via `paths.ts`, and the only new
  process control (the drain controller's SIGINT → SIGTERM → `taskkill` ladder, Phase F)
  keeps `taskkill` as a Windows-only last resort behind the existing platform check.
