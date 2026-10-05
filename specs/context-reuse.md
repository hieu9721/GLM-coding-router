# Spec: efficient delegation and context reuse

**Status: RESEARCH PROPOSAL — documentation only, implementation not authorized yet.**
Date: 2026-09-22. No package bump or release assignment.
Rationale, measured fixture facts and external sources:
[Agent Communication & Context Reuse](../docs/GLM%20Coding%20Router%20%E2%80%94%20Agent%20Communication%20%26%20Context%20Reuse.md).

## Problem

Every worker invocation currently constructs a prompt-driven headless Claude process
without explicit session reuse. Project exploration and task context can be repeated.
The router records provider session IDs and checkpoints, but does not yet resolve a
versioned context package for subsequent work. Its completion metrics omit cache-read
and cache-write tokens already present in committed fixtures.

Optimize total cost and latency per accepted task, not merely prompt length, tool
call count, or a worker's own claimed completion. A task can use fewer fresh tokens
while replaying more cached history, producing more output or requiring more repairs.

## Approach

### Contracts

| ID | Required behavior |
|---|---|
| K1 | Mandatory user/repo/nested instructions remain authoritative and are never silently dropped to meet a context budget |
| K2 | Workers verify current contents of files they edit; reuse removes redundant exploration, not necessary verification |
| K3 | Existing worker stdout and MCP framing stay intact; opt-in task protocol must not silently replace legacy final text |
| K4 | Router history stores numeric metrics, identifiers and bounded structured metadata, not raw source, full prompts, transcripts or reasoning |
| K5 | Resume is scoped to a validated task/worktree/runtime/role/model/tool-policy tuple with a single active owner |
| K6 | Stale/unknown context is labeled and refreshed; hashes include relevant uncommitted work, not HEAD alone |
| K7 | Missing usage is unknown, not zero; report cached/new/total semantics and measurement confidence explicitly |
| K8 | No unrestricted child MCP, permission bypass, credential switching or automatic model/API purchase to optimize cost |

K4 follows v2 C3 for newly introduced context artifacts. Existing handoff `diff.patch`
is an existing source-bearing artifact, not permission to add a transcript/source cache.
Native runtime session persistence is separate and must not be copied into router storage.

### Phase 0 — trustworthy measurement first

Add an optional versioned usage payload to events/summaries and cost samples. Preserve
legacy `tokensIn`/`tokensOut` semantics until an explicit migration; never reinterpret
old history as though cache counters had been recorded. Missing fields in old events
map to null. Do not break readers of existing runs or benchmark JSON.

Proposed normalized view:

```ts
interface TokenUsageV1 {
  schemaVersion: 1;
  freshInput: number | null;
  cacheReadInput: number | null;
  cacheWriteInput: number | null;
  totalInput: number | null;
  output: number | null;
  reasoningOutput: number | null; // subset when the provider says so; never add twice
  basis: "terminal-result" | "deduplicated-messages" | "unknown";
  semantics: "anthropic-disjoint" | "input-includes-cache" | "unknown";
  completeness: "complete" | "partial" | "unknown";
}
```

- For verified Anthropic-style disjoint counters, total input is fresh + read + write.
  For APIs reporting inclusive input, cache read is a subset and must not be added.
- Validate nonnegative finite values. Missing cache fields cannot imply zero unless
  the provider contract establishes that default; otherwise total may remain null.
- Prefer terminal aggregate for one invocation. Never sum it again with per-message
  counters or `modelUsage`. Repeated message IDs/partial frames must not double-count.
- Attempt to preserve usage on failed/cancelled runs when supplied. If the process
  dies without reliable accounting, report partial/unknown; do not exclude all failures
  from cost-per-accepted-task denominators.
- On resumed sessions, establish whether each runtime counter is per invocation or
  session cumulative before aggregation. Store a baseline/delta only when verified.
- Do not trust Claude Code's model-price-derived USD for GLM. Keep observed plan credit
  delta separate from any estimate using a dated provider rate card.
- Credit attribution records concurrent runs, external usage unknown, provider reset,
  time window and freshness. Existing local active-run checks cannot rule out another
  machine using the same account. Report contaminated measurements as unknown.
- Native token counters are preferred. Estimated packet sizes record estimator/version;
  a characters-per-token heuristic is not an exact GLM tokenizer.

Seed regression expectations from committed fixtures:

| Fixture | Fresh | Cache read | Cache write | Total input | Output |
|---|---:|---:|---:|---:|---:|
| basic | 1644 | 7168 | 0 | 8812 | 144 |
| allowed | 339 | 8448 | 0 | 8787 | 111 |
| edit | 2145 | 16640 | 0 | 18785 | 545 |

These test accounting, not a savings claim. Per-attempt metrics also track wall
time, time to first edit, exploration tool counts, changed paths, retries, validation
and orchestrator acceptance. Record failure/blocked/no-edit outcomes truthfully.
Provider envelopes, process exit and validation may disagree. A terminal event named
success is not acceptance evidence by itself; check error indicators and actual
validation. Include an auth-rejected run in failure-accounting regression tests.

### Phase 1 — project map and task context

Use a small human-reviewed project map and existing authored specs as the stable
knowledge layer. A deterministic local selector starts from explicit task files,
entry points and dependency/test references. A vector database, embedding calls and
an always-running indexer are out of scope initially.

Repository instruction cleanup is a separate, reviewed documentation change. Do not
silently edit AGENTS.md outside its managed block or bypass the current requirement
to read MEMORY.md. The proposed map supplements instructions until that cleanup is
explicitly agreed. Archive long historical material only as an intentional docs task.

Context package has three parts:

1. Required instruction references and stable project/module facts.
2. Task packet: all AGENTS.md-required headings, task-specific requirements, acceptance
   and validation, allowed/forbidden files, previous-attempt delta.
3. On-demand file/symbol references verified against the current workspace.

Proposed identities/metadata (not a new instruction hierarchy):

```ts
interface ContextManifestV1 {
  schemaVersion: 1;
  contextId: string;
  repoId: string;
  worktreeId: string;
  baseCommit: string | null;
  policyHash: string;
  templateVersion: string;
  references: Array<{
    path: string;       // repo-relative after canonical path checks
    contentHash: string;
    role: "instruction" | "architecture" | "source" | "test" | "build-config";
    symbol?: string;   // preferred anchor; line numbers are advisory
    required: boolean;
  }>;
  estimatedTokens: number | null;
  estimatorVersion: string | null;
}
```

Task text is assembled transiently, not persisted wholesale into manifests/history.
Authored task documents may be referenced; the router must not auto-create source
or prompt archives. Allow in-memory snippets for transmission; persisted metadata
has paths/hashes/symbol names only. References are data, never executable commands.

Freshness protocol:

1. Resolve canonical repo/worktree paths; account for Windows case and symlinks.
2. Hash referenced contents plus applicable instructions and build/dependency metadata.
   Include relevant staged, unstaged and explicitly allowed untracked files. For new
   files, fingerprint the parent inventory so additions/deletions invalidate indexes.
3. Immediately before dispatch, revalidate. Stable hashes reuse selection; differences
   invalidate affected modules and dependent references. Unknown dependencies require
   a conservative wider refresh, not silent trust.
4. Before edit, the worker reads current target source. Session context is not a lock
   on external editors; report an observed unexpected change for reconciliation.
5. Secret/ignored files, paths outside the worktree and binary/generated/vendor trees
   are excluded by default. Explicitly requested external reference material requires
   an explicit allowed root, never unrestricted path traversal.

Initial experimental **extra context** budgets: stable map 800–1500 estimated tokens,
task/module context 2000–4000, result narrative 300–600. They are soft targets, not
quality caps. Never truncate required acceptance criteria, instructions or critical
evidence to fit them. A larger task can exceed targets with a recorded reason.
Keep mandatory startup context, tool definitions and dynamic history in separate
measurement categories so a small packet is not misreported as a small total context.

Cache-friendly serialization: stable policy/template/module text first; task ID,
timestamp, delta and request-specific content later. Stable ordering/formatting reduces
unnecessary prefix churn. The router controls only its own packet; it cannot promise
that a CLI's hidden prompt or a provider cache will match across runs. No keepalive
LLM calls or speculative prewarming in this phase.

### Phase 2 — bounded session reuse

Use existing `AgentInitialized.sessionId` evidence. New invocations get new run IDs;
related attempts retain a logical task ID/lineage. Integrate with v3's eventual
TaskGraph and ExecutionLease rather than inventing an incompatible task owner.

The existing event provider label `zai.zcode` is a legacy identity in v2; today's
runtime is Claude Code over Z.ai. Store runtime identity/version separately and never
feed that Claude session ID to native ZCode or Codex in a future adapter.

Resume eligibility requires:

- Explicitly related task/attempt, correct canonical worktree and current context.
- Same backend/runtime, selected model, role and effective tool/permission policy.
- Session ID recorded by this router, still available, no active session lease.
- Required instructions unchanged; bounded history/usage and no unresolved corruption.

Always reapply child-only env and strict MCP/tool restrictions. Never use generic
`--continue`, `--last` or a nearest-session heuristic in multi-worker scheduling.
Treat a change from reviewer to worker as a new session even if both use GLM.

Lifecycle:

```text
eligible task -> validate context -> acquire session lease -> resume exact ID
                                                           |
                                         result/checkpoint -> release lease

ineligible / unknown / expired -> fresh session + current task context
```

Lease acquisition must be atomic. Cancellation/crash releases or marks stale leases;
stale recovery checks liveness and task state before reuse. Do not auto-replay edits
after an ambiguous failed resume: first inspect workspace changes and recorded task
status. No session transcript copying or mutation by the router.

Keep reuse opt-in until benchmarks pass. Defaults remain fresh sessions. End reuse
at a semantic task boundary, policy/model/worktree change, poor context relevance or
budget threshold. Test a small bounded number of related follow-ups first; do not
assume a fixed universal token/context limit for every runtime. If compaction is used,
include its usage and refresh cost in metrics. Native compaction availability is a
capability check, not a portable CLI promise.

### Phase 3 — economical communication

Design-only alignment with v3; no agent mesh or new always-on service in this update.
Use existing event bus/registry for mechanical liveness/status operations. Add an
opt-in protocol envelope when an orchestrator can actually consume/respond to it:

```ts
interface TaskMessageV1 {
  schemaVersion: 1;
  taskId: string;
  attemptId: string;
  messageId: string;
  type: "assignment" | "need_context" | "checkpoint" | "result"
      | "failure" | "decision_required";
  contextId: string;
  artifactRefs: string[];
}
```

Each message type gets its own bounded validated payload. Do not put full tool logs,
chat history or source blobs inside the envelope. Deduplicate message IDs; reject
wrong-task context IDs; do not resend the complete assignment on every heartbeat.
Mechanical polling/notifications must not trigger unnecessary model turns.

The current one-shot CLI has no interactive context-request broker. Initial workers
read scoped local references themselves, or finish with a clear blocked/needs-context
result. A resumable request/reply broker is a later adapter capability; do not claim
it already exists. Legacy stdout stays final text; structured messages require an
explicit separate protocol/channel design with MCP compatibility tests.

Group work by acceptance boundary (e.g. implementation + focused tests), not by each
tiny file edit. Use parallel workers only on independent scopes/worktrees with an
identified integration owner; measure duplicated context and merge/review overhead.
No worker-to-worker broadcasts or self-delegation loop. Packet file lists do not
enforce permissions; preserve existing review/write tool separation.

## Scope

Potential implementation locations after authorization:

| Area | Purpose |
|---|---|
| `src/events/{types,claude-adapter}.ts` | Additive normalized usage and verified runtime metadata |
| `src/runs/{store,worker-run}.ts`, `src/budget/estimator.ts` | Accounting provenance, task/attempt lineage, acceptance metrics |
| `src/commands/benchmark.ts` | Context strategy experiments and complete cost reporting |
| New `src/context/` | Manifest validation, deterministic selection and freshness checks |
| New session helper under `src/runs/` | Eligibility and atomic lease, capability-gated resume |
| Task binaries / MCP / delegate | Opt-in arguments only after shared primitive contracts are tested |
| Existing authored project docs | Optional reviewed map/index cleanup, no automatic instruction rewrite |

No changes yet to code, dependency graph, config defaults, pricing tables, user's
keys, native agent memory, session retention, releases or published package.

## Acceptance criteria

- [ ] Usage fixture totals match the table; cache read/write and failed-attempt costs retained.
- [ ] Unknown counters and contaminated quota deltas never become zero-cost runs.
- [ ] Old events remain readable; per-message/session cumulative counters cannot double-count.
- [ ] Context packages retain mandatory instructions and all task acceptance criteria.
- [ ] Freshness covers staged/unstaged/untracked changes, renames, dependencies and instructions.
- [ ] Worker reads current edit targets; irrelevant project-wide rereads decrease in benchmark.
- [ ] Wrong repo/worktree/model/role/tool policy and concurrent session use refuse resume safely.
- [ ] No raw prompt/source/transcript/secret enters new router metadata or logs.
- [ ] Read-only review and strict MCP isolation survive every resume/fallback path.
- [ ] Worker/MCP stdout protocols unchanged unless explicit new mode is requested.
- [ ] Quality and cost evidence support enabling an optimization; no unsupported percentage claim.

## Validation and experiment plan

First: offline fixtures/unit/integration tests for metric normalization, invalidation,
path containment, message deduplication, resume-argument construction and lease recovery.
Use fake-agent recordings; no live quota required for these contracts.

Then an explicitly requested, budgeted live experiment once credentials are working:

| Arm | Experiment |
|---|---|
| A | Current fresh-worker workflow |
| B | Fresh + stable map + scoped task context |
| C | B + exact-session follow-up on related tasks |
| D | Task switch: long resumed session versus fresh + compact references |

Pilot: 4 representative task sequences x 2 repeats for A and B = 16 executions;
C/D use separate bounded follow-up comparisons after that signal. These counts are
a proposed small start, not a statistically sufficient proof. Set a total credit/time
ceiling before dispatch. No experiment is scheduled or launched by this document.

Use the same repository snapshot, model, permission policy, requirements, tests and
acceptance reviewer per pair. Randomize/interleave arm order and record observed
cache counters, runtime version, time/price conditions, quota resets and background
account use. Cache warming cannot be perfectly controlled; report that limitation.
Use isolated experiment worktrees; task completion does not authorize deleting
dirty worktrees or user changes.

Report per arm: acceptance rate, rework rate, cost/accepted task, median latency,
first-edit latency, token categories and exploration-read counts. Add enough repeats
before publishing tail percentiles/confidence claims. Include map/index generation,
maintenance, planner review and retries; amortize one-time costs explicitly and show
both first-task and repeated-task results. For unavailable parent-agent attribution,
show unknown separately instead of claiming full-system savings.

Promotion gate: no critical correctness/security regression, comparable acceptance
quality, and repeatable improvement in total credits or acceptance latency. A proposed
20% median credit reduction can be a research target, never a promised result or a
reason to ignore quality. Re-run full build/tests/lint only after implementation.

## Open questions before implementation

1. Native resume semantics, transcript retention and usage counter scope on the exact
   installed Claude Code + Z.ai stack; positive cache fields in fixtures are not a
   complete contract for all versions.
2. How much baseline startup context comes from mandatory repo/user instructions,
   loaded skills and the runtime itself; how much can this router actually control?
3. Minimum project-map information that avoids re-exploration without stale advice.
4. Whether same-task resume beats fresh scoped context after a long delay or model change.
5. Whether budget/usage observation is clean enough for attribution with other account activity.
6. Exact public CLI/protocol flag names, retention policy for metadata and integration
   into v3 TaskGraph/ExecutionLease. Do not reserve commands as if already shipped.
