# Spec: glm-fast + profiles

## Problem

The v0.1 CLI exposes only two model tiers implicitly (`glm-5.3` for chat/worker,
`glm-5.3-flash` for Claude's background calls) with no way to start an interactive
session pinned to the fast model, and no way to save per-task model/maxTurns
combinations — every `glm-worker --max-turns`-style tuning has to be repeated by
hand (spec §54 lists `glm-fast`, worker profiles, custom model profiles for v0.2).

## Approach

Two additions, both pure config/CLI layer — no changes to spawning, env injection,
or key resolution:

1. **`glm-fast`** — fifth binary, interactive like `glm-chat` with pass-through
   args. It builds the effective config with `models.main = models.fast`, so all
   three `ANTHROPIC_DEFAULT_*_MODEL` slots in the injected child env point at the
   fast model. Profile (if any) is applied first, then the fast pin — a profile's
   `fast` model flows into every slot; a profile's `main` is intentionally
   overridden by the pin.

2. **`--profile <name>`** — consumed by all four task binaries (`glm-chat`,
   `glm-fast`, `glm-worker`, `glm-review`) before prompt resolution; the flag and
   its value are removed from the args passed on (rest of argv untouched). A
   profile is a named entry under `profiles` in config.json:

   ```json
   "profiles": {
     "test":     { "fast": "glm-5.3-flash", "workerMaxTurns": 10 },
     "frontend": { "main": "glm-5.3", "reviewMaxTurns": 30 }
   }
   ```

   `applyProfile(config, name)` overlays `main`/`fast`/`workerMaxTurns`/
   `reviewMaxTurns` onto the loaded config; unknown profile names fail with
   `ERROR [11] CONFIG_INVALID` listing the defined profiles. `--profile=x` and
   `--profile x` both parse; a missing value errors. Note: this flag is ours —
   it shadows Claude Code's own `--profile` in these four wrappers; pass-through
   users must use `claude` directly for that.

   Out of scope: a `config set profiles.x…` editing flow (records need whole-map
   writes; edit config.json by hand for v0.2), non-model profile fields (tools,
   permission modes).

## Scope

- `src/core/profile.ts` (new): `extractProfileFlag`, `applyProfile`.
- `src/core/config.ts`: `ProfileSchema` + `profiles` record field (default `{}`).
- `src/bin/glm-fast.ts` (new): interactive, fast-pinned, `--profile` aware.
- `src/bin/{glm-chat,glm-worker,glm-review}.ts`: extract + apply profile flag.
- `package.json`: `glm-fast` bin entry, version 0.2.0.
- `tests/fixtures/fake-agent.mjs`: also dump the OPUS/HAIKU model env slots.
- Tests: `tests/unit/profile.test.ts`, `tests/unit/glm-fast.test.ts`.
- Docs: README commands/profiles, AGENTS.md structure lines, MEMORY.md.

## Acceptance criteria

- [ ] `glm-fast` forwards pass-through args interactively and the child env maps
      opus/sonnet/haiku slots all to `config.models.fast`.
- [ ] `glm-worker --profile test` drops the flag from the prompt, applies
      `workerMaxTurns`/`main`/`fast` from the profile; `glm-review` likewise for
      `reviewMaxTurns`.
- [ ] Unknown profile → `ERROR [11]` naming available profiles; `--profile`
      without value → `ERROR [11]`.
- [ ] Config without `profiles` key keeps validating (default `{}`).
- [ ] `npm run build`, `npm test`, `npm run lint` green; no secret in any new output.

## Validation

```
npm run build && npm test && npm run lint
npx vitest run tests/unit/profile.test.ts tests/unit/glm-fast.test.ts
glm-fast --version   # real run: prints claude version via fast-pinned env
```
