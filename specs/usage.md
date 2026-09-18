# Spec: usage snapshots (v0.5, spec §54)

## Problem

There is no way to see GLM Coding Plan consumption from the CLI — users must
open the Z.ai dashboard. Spec §54 (v0.5) asks for usage integration (GLM
credit consumption, Claude quota, Codex usage) "where provider APIs allow
reliable retrieval".

## Approach

One new read-only command, `glm-router usage`. Research first (2026-09-18):

- **Z.ai**: `GET https://api.z.ai/api/monitor/usage/quota/limit` with
  `Authorization: Bearer <ZAI_API_KEY>` — the monitor API Z.ai's own dashboard
  uses (also adopted by community trackers). **Verified live** against the
  real endpoint: returns `{code, msg, data: {limits: [...], level}, success}`
  where each limit is `{type:"CREDIT_LIMIT", unit, number, usage (total),
  currentValue (consumed), remaining, percentage, nextResetTime (ms)}` and
  `level` is the plan tier (e.g. `lite`). The 5-hour window arrives as
  `unit:3, number:5`; the weekly window as `unit:6, number:1` (confirmed by
  the reset timestamps ~5h vs ~7d apart). A second endpoint
  (`model-usage`) returned an empty body in probing — not reliable, not used.
- **Claude Code**: no headless usage/quota surface exists (`claude --help`
  has no such command; no public API) — and claude.ai quota is irrelevant
  when traffic is routed to GLM.
- **Codex**: no usage command in the CLI; no public API for plan usage.

So the command shows what is reliably retrievable and says so about the rest:

```
Z.ai Coding Plan (level: lite)
  5-hour window   912 / 2000 credits (45%) — resets 2026-09-18T15:12:52Z
  weekly          3304 / 10000 credits (33%) — resets 2026-09-24T15:19:26Z

Local (benchmark reports)
  runs 3 · tokens 6927 in / 2190 out · last 2026-09-18T03:03:45Z

Claude quota   not available — Claude Code exposes no headless usage API
Codex usage    not available — Codex exposes no plan-usage API
```

- **Z.ai section** (network, the point of the command): fetch with a 10 s
  timeout; window labels map `unit 3` → `<number>-hour window`, `unit 6 &
  number 1` → `weekly`, anything else renders a generic `unit <u> × <n>`
  label (defensive — the enum is undocumented). HTTP error, non-200 `code`,
  or malformed body → the section renders `✗ <reason>` and the command exits
  1 (doctor-style partial render, not a stack trace).
- **Local section** (offline, always reliable): aggregates the saved
  benchmark reports (`<configDir>/benchmarks/*.json`, specs/benchmark.md):
  run count, summed input/output tokens, newest `finishedAt`. Malformed
  files are skipped; an empty directory renders `(none yet — run
  glm-router benchmark)`.
- **Claude/Codex sections**: fixed "not available" lines with the one-line
  reason — the spec's hedge made visible instead of silently missing.
- Missing key → `ERROR [10]` (the primary section needs it). The
  Authorization header is never logged; no secret appears in any output.
- `--json` emits `{zai, local, claude, codex}`; `--quiet` suppresses the
  banner lines only.

Out of scope: `model-usage` endpoint (unreliable in probing), China-region
base-URL override, polling/watch mode, cost conversion to currency.

## Scope

- `src/commands/usage.ts` (new): `usageCommand(options, deps)` with
  repo-standard DI (`home`, `env`, `readUserEnv`, `fetchImpl`, `now`).
- `src/cli.ts`: `usage` command wiring.
- Tests: `tests/integration/usage-command.test.ts` (verified real payload
  shape as fixture data; fake fetchImpl; fabricated benchmark reports).
- Docs: README usage section, AGENTS.md structure line, MEMORY.md,
  version → 0.5.0.

## Acceptance criteria

- [ ] With a key and the real endpoint shape, text output shows plan level,
      both windows with consumed/total, percentage, reset time; `--json`
      mirrors it; exit 0.
- [ ] Window labels: `unit 3 number 5` → "5-hour window"; `unit 6 number 1`
      → "weekly"; unknown enum → generic label.
- [ ] No key → `ERROR [10]`; fetch rejection / HTTP ≥400 / `code !== 200` /
      malformed body → `✗` reason rendered, exit 1, no stack trace.
- [ ] Local aggregation counts runs and sums tokens across report files;
      empty dir → `(none yet …)`; malformed JSON files are skipped.
- [ ] Claude/Codex "not available" lines always render.
- [ ] No output path ever contains the key value.
- [ ] `npm run build`, `npm test`, `npm run lint` green.

## Validation

```
npm run build && npm test && npm run lint
npx vitest run tests/integration/usage-command.test.ts
# real run (needs key): glm-router usage
```
