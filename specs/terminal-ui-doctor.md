# Spec: terminal UI and credential diagnostics (pre-v3)

**Status: IMPLEMENTED (core) — see "Implementation status" note above the
acceptance checklist below for what is done vs. still pending.**
Date: 2026-09-22. Candidate release: v2.1, not a package-version decision.
Product design and wireframes:
[Terminal UI & Credential Diagnostics](../docs/GLM%20Coding%20Router%20%E2%80%94%20Terminal%20UI%20%26%20Credential%20Diagnostics.md).

## Problem

The management CLI lacks a consistent visual hierarchy in PowerShell/CMD. Doctor
reports HEALTHY on key presence alone. Its unauthenticated GET considers even 401
reachable, while `usage` performs the authenticated request that exposes rejection.
The resolver prioritizes the process key, so an existing terminal may keep using an
old value after the per-user store changes.

Verified in `src/commands/doctor.ts`, `doctor-command.ts`, `src/core/zai-key.ts`
and `zai-quota.ts` at `c0867ac`. This establishes code defects, not the reason for
any particular real account's failure. No real credential diagnosis was performed.

## Approach

### A. Shared terminal presentation

Extend the dependency-free Writer/paint layer, keeping raw ANSI exclusively in
`src/tui/render.ts`. Add `src/tui/command-ui.ts` for management commands. Presentation
must not fetch data, read credentials or choose routing behavior.

Proposed helper surface (implementation may refine names without changing behavior):

```ts
type UiStatus = "ok" | "warn" | "fail" | "info";

createCommandUi(writer: Writer, options?: { quiet?: boolean }): {
  header(title: string, subtitle?: string): string;
  section(title: string): string;
  row(label: string, value: string, status?: UiStatus): string;
  detail(text: string): string;
  footer(text: string): string;
  bar(percent: number | undefined): string;
};
```

Helpers return strings without a final newline; multiline values are allowed.
The caller chooses the output stream and performs writes. Use package version, not
a hardcoded release number. Status/usage JSON branches bypass presentation entirely.

| Surface | Contract |
|---|---|
| Header | Compact ASCII outline, product/version/screen, cyan and bold where supported |
| Sections | Stable order, one group per name, whitespace and muted rules |
| Rows | Aligned labels/values, explicit OK/WARN/FAIL/INFO labels; color is supplemental |
| Details | Wrap raw text before styling; long paths preserved, continuation indented |
| Summary | Clear verdict and actionable next step; no unverifiable success wording |
| Quota | ASCII consumed bar; <70 green, 70–<90 yellow, >=90 red; clamp bar to 0–100 |

Terminal contracts:

- At 80/120 columns use aligned rows; at 40 stack long values. At 24 omit the frame
  if necessary. No visible line wider than the available columns (excluding newline).
- Width uses display cells, not ANSI string length; test wide characters and long
  unbroken paths. An unknown/invalid width uses 80. Do not silently truncate facts.
- ASCII borders/badges/bars; no required emoji, box-drawing characters or special font.
- Sanitize untrusted control characters in external display text before styling.
- Color only on a capable TTY; disable for nonempty NO_COLOR, TERM=dumb and pipes.
  Do not force color in redirected output. No cursor animation in these static screens.
- `--quiet` suppresses decorative headers/footers and unsolicited tips, while keeping
  the requested diagnostic/usage rows and failures. This rule is scoped to these
  screens; do not refactor every command's quiet behavior in this feature.
- `--json` contains only JSON on stdout, no banner/progress/ANSI; diagnostics for an
  argument error use the existing error path on stderr.

### B. Command experience

1. `glm-router` with no subcommand renders the offline landing page and exits 0.
   Group checks/monitoring, work and setup with runnable examples. Do not read the
   user key/config or call a provider just to display the landing page.
2. Preserve Commander's full help and nested help, options, aliases and error behavior.
   Add compatible styling/intro only; do not maintain a second full command registry.
   Landing's curated shortcuts may reference the existing commands explicitly.
3. Root `--json` without a data-producing command is an actionable argument error
   (exit 2), not decorated help on stdout. Existing command-level JSON remains valid.
4. `status` stays offline with unchanged JSON. Text says key is configured but not
   verified in this invocation and points to doctor; do not claim validity.
5. `usage` keeps its fetch, aggregation, labels, quantities, reset timestamps, JSON
   shape and exit semantics. Add bars and remaining values when supplied; missing
   fields stay unknown. Never treat missing quota as zero. Percent may be calculated
   from finite consumed/total with total > 0. Styling thresholds do not affect routing.

### C. Credential inspection without changing runtime precedence

Keep `resolveZaiApiKey()` semantics: process environment -> per-user store -> missing.
Do not change agent authentication, parent environment, persisted key or config.

Doctor uses an invocation-local snapshot of both sources, read once:

1. Read and trim the process value and stored value privately.
2. Resolve the effective key using the same precedence as workers.
3. Compare only when both are nonempty. A difference means a possible stale process
   value OR an intentional override; do not assert which one without evidence.
4. Warn that process wins. Give shell-specific remediation text without executing it:
   PowerShell `Remove-Item Env:ZAI_API_KEY`; CMD `set ZAI_API_KEY=`; POSIX
   `unset ZAI_API_KEY`. Only suggest clearing when a stored replacement exists.
5. Explain that restarting the hosting app refreshes inherited environment, while a
   shell profile/intentional override may need its own update. `key set` saves a key
   but cannot rewrite the environment of an already-running parent terminal.
6. Authenticate exactly the selected key. Do not retry with the stored key on rejection;
   that would hide the key the next worker will actually use.

The inspector may be a separate helper next to the resolver. Its private snapshot
can contain key values; `DoctorReport`, public JSON, logs and exceptions cannot.
If the store cannot be read, retain a present process key and mark comparison
unavailable rather than claiming equality or absence. The store helper may need an
additive diagnostic read result; preserve existing resolver behavior for other callers.

Public comparison: `match | different | not-comparable | unavailable`.
Public `keyMismatch`: true for different, false for match, null otherwise.
An unavailable comparison produces ATTENTION if authentication succeeds.

No key history/fingerprints are stored. A still-valid old key with no differing
local replacement cannot be diagnosed as rotated; documentation must state this limit.

### D. Authenticated doctor by default

Use `fetchZaiQuota()` against `ZAI_QUOTA_URL` with the effective key. One fresh GET,
existing 10-second timeout, no cached budget snapshot, no generation call or task.
Missing key skips the request and fails the local required check.

`runDoctorChecks()` stays synchronous/offline for init and other existing callers.
`doctorCommand()` coordinates inspection, local checks, async authentication and
rendering. Pass the private snapshot internally so local checks and network request
use the same key even if the store changes mid-command. Never return it in the report.

The shared monitor client must provide structured errors, not require regex matching
provider messages. Proposed kinds:
`unauthorized | forbidden | rate-limited | http | network | invalid-response | provider`.
Keep the existing `fetchZaiQuota` signature and successful return type for callers.

| Provider result | Authentication state | Check | Guidance |
|---|---|---|---|
| HTTP success + accepted body/schema | verified | ok | Monitor accepted the selected key |
| HTTP 401 | rejected | fail | Replace/update selected key; inspect source mismatch |
| HTTP 403 | rejected | fail | Access denied; check key/account permissions, not necessarily expiry |
| HTTP 429 | unverified | warn | Rate limited; retry later |
| HTTP 5xx / other unexpected HTTP | unverified | warn | Provider/endpoint error; retry or inspect configuration |
| Network exception or timeout | unverified | warn | Check network/proxy and retry |
| Invalid JSON or malformed schema | unverified | warn | Unexpected provider response; cannot validate |
| `success:false` / non-success provider code | unverified | warn | Provider rejected request; unknown reason is not proof of invalid key |
| Explicit offline | skipped | warn | Online authentication not performed |
| Missing key | missing | fail | Run key set or set the supported process override |

Map additional provider auth codes only after documenting evidence and adding a
fixture; never infer invalid credentials from arbitrary message substrings.

Success validation: body is a non-array object, `code === 200`, `success` absent or
true (legacy success payloads may omit it), data is a non-array object, and `limits`
is an array. Entries must be objects; supplied numeric quota fields must be finite
numbers, optional fields may be absent, optional level must be a string. Empty limits
is a valid authenticated response with unknown quota, never zero quota. Missing or
wrong-type limits is unverified. Document this stricter shared-client behavior and
test existing usage/dashboard/budget/MCP consumers before accepting the change.

Security: construct safe local messages from error kinds and safe numeric codes;
do not echo raw response bodies, provider `msg`, fetch exception messages, headers
or URLs containing credentials. Use `redact` on diagnostic output that could include
either known key. No key prefixes, suffixes, hashes, auth headers or secret snapshots
in stdout/stderr, disk, history or debug logs. Authentication requests use the fixed
monitor URL; do not forward secrets to redirect destinations (`redirect: "error"`).

`verified` means monitor access was accepted, not all model routes are authorized.
Zero quota does not reject an otherwise authenticated key. Doctor does not run an
inference to prove model permissions.

### E. Options, summary and compatibility

`doctor --offline` makes zero provider requests and labels auth skipped. Local checks
may still read the platform key store and locate executables. `--network` retains
the extra unauthenticated reachability probe for the configured Anthropic base URL;
clearly label it as reachability, not authentication. `--offline --network` fails
validation before reading secrets or issuing requests (exit 2). Run auth and optional
reachability concurrently after the local snapshot, each bounded by its timeout.

Overall summary precedence (first matching row wins):

| Condition | `status` | Exit |
|---|---|---|
| Any required local failure, missing key, or rejected auth | ISSUES | 1 |
| Auth is unverified/skipped, or explicitly requested reachability is unavailable/5xx | UNVERIFIED | 1; 0 only for explicit offline with no required local failures |
| Verified auth + differing sources or unreadable store comparison | ATTENTION | 0 |
| Verified auth + remaining required checks pass | HEALTHY | 0 |

Optional Codex/skills/PATH shim warnings do not make an otherwise valid setup fail.
Their rows remain visible; HEALTHY is not a claim that all optional features exist.
An unauthenticated 401/403 in the reachability probe still means reachable; the
separate authenticated check decides credentials.

Preserve JSON fields `status`, `checks`, `keySource`, optional `network`. Add:

```ts
authentication: {
  state: "verified" | "rejected" | "unverified" | "skipped" | "missing";
  checked: boolean; // true iff a monitor request was attempted
  method: "zai-quota-monitor";
  reason: string;   // stable reason code, e.g. "http-401", "offline", "timeout"
  detail: string;   // safe local message
};
keyComparison: "match" | "different" | "not-comparable" | "unavailable";
keyMismatch: boolean | null;
```

Reason codes are a documented closed set when implemented: `accepted`, `http-401`,
`http-403`, `rate-limited`, `http-error`, `timeout`, `network-error`,
`invalid-response`, `provider-error`, `offline`, `missing-key`.
The same auth/comparison state feeds `checks`, text, JSON and exit; avoid separate
JSON/text branches with duplicated requests or different conclusions.

Intentional compatibility changes: ordinary doctor now uses the network and can
exit 1 for inability to verify; the top-level `status` in doctor JSON gains
UNVERIFIED/ATTENTION enum values; root-with-no-command gains a landing page/exit 0.
Existing integrations must use `--offline` for old local-only behavior, and account
for the expanded enum. These are release-note items, not a claim of byte-for-byte
backward compatibility. Worker/MCP protocols and status/usage JSON schemas remain
unchanged.

## Scope

| Area | Planned changes |
|---|---|
| `src/tui/render.ts`, new `command-ui.ts` | Capabilities, safe styles, width-aware static helpers |
| `src/cli.ts` | Landing/help and doctor --offline wiring |
| `src/commands/doctor.ts`, `doctor-command.ts` | Local inspection integration, auth state, summary/JSON/text |
| `src/core/zai-key.ts` or adjacent new helper | Private two-source inspector; resolver order unchanged |
| `src/core/user-env.ts` if needed | Additive read diagnostics; existing reader contract preserved |
| `src/core/zai-quota.ts` | Typed errors, schema validation, safe messages, redirect policy |
| `src/commands/status.ts`, `usage.ts` | Text presentation only; status explicitly offline |
| Tests | New UI/credential/quota cases; adapt intentional doctor contract changes |
| Docs | README command help/troubleshooting plus memory of actual implementation |

Out of scope: v3 providers/role switching, new renderer dependencies, full-screen
menus, dashboard polling changes, automatic key rotation, global installs,
package bump/publish, commits and changes to Claude/Codex authentication.

## Implementation sequence (not started)

1. **Credential foundation:** typed monitor failures + inspector, fake-response/store
   tests. Review secret handling in the orchestrator before integration.
2. **Doctor behavior:** default verification, offline flag, shared verdict logic,
   fresh snapshot, JSON and exit regression tests. Test init still offline.
3. **UI foundation:** helpers and width/color/ASCII tests, no fetching in presentation.
4. **Screen integration:** landing/help, doctor/status/usage; verify real rendering.
5. **Acceptance:** full build/tests/lint, Windows shell checks and optional authorized
   read-only monitor validation. Update release notes after behavior is implemented.

Steps 1 and 3 can be delegated independently after implementation is authorized.
Use disjoint file packets; primary agent owns credentials/security, integration and
final review. Never count a worker's success report as acceptance evidence.

## Implementation status (2026-09-22)

Core implemented: `src/core/zai-quota.ts` (typed `ZaiQuotaError`, schema validation,
`redirect: "error"`), `src/core/key-inspector.ts` (two-source comparison), `src/core/user-env.ts`
(`readUserEnvDiagnostic`, additive), `src/commands/doctor-auth.ts` (authentication state +
verdict precedence, pure/unit-tested), `src/commands/doctor-command.ts` (rewritten: online-by-default,
`--offline`/`--network`, new JSON fields), `src/tui/command-ui.ts` (UI foundation),
`src/commands/landing.ts` (root landing page), `src/cli.ts` wiring, `src/tui/render.ts`
(`TERM=dumb` now honored — a real pre-existing gap found and fixed while building this).
`status`/`usage` got targeted, safe changes (wording, quota bars) but not the full box/section
UI — deliberately conservative to avoid rewriting their already-pinned output contracts in the
same pass as the doctor rewrite. 646 tests pass (up from 557), build+lint clean.

Not done: full `command-ui` hierarchy applied to `status`/`usage` screens; `--help` intro styling;
wide-character (CJK/emoji) display-width handling in `command-ui.ts` (current width math is
`string.length`, not display cells — spec explicitly calls this out and it was not addressed);
the formal manual PowerShell 5.1 / PowerShell 7 / CMD acceptance pass (only exercised via the
built CLI in this Git Bash / PowerShell 7 dev environment).

## Acceptance criteria

- [x] Full Commander help and commands remain reachable; landing is offline (verified live).
- [ ] Four management screens share the proposed hierarchy and actionable hints — landing +
      doctor yes; status/usage partial (see note above).
- [ ] Width 24/40/80/120 and long paths pass (unit-tested); wide characters do not — known gap.
- [x] NO_COLOR, TERM=dumb, pipes, quiet and JSON behave as specified (incl. the TERM=dumb fix).
- [x] Doctor authenticates the exact effective key once per invocation, uncached.
- [x] Two-source comparison catches a stale override without changing key precedence.
- [x] Rejection, denied access, outage, rate limiting and unknown responses stay distinct.
- [x] Missing, offline and unreachable cases never incorrectly say HEALTHY.
- [x] No secret can appear through either normal output or reflected provider errors (tested,
      and this work incidentally found and reported a real key exposed in a test-tooling gap —
      see the 2026-09-22 session log entry in MEMORY.md).
- [x] Init/status remain offline; usage/dashboard/budget/MCP monitor callers remain safe
      (full regression suite green, including all pre-existing dashboard/budget/MCP tests).
- [ ] Build, full tests, lint pass (yes); documented Windows manual checks (not done — pending).

## Validation

Use injected stores/fetch and fake-agent fixtures; automated tests make no live API calls.

| Group | Required cases |
|---|---|
| Sources | process only; store only; equal; different; whitespace; both missing; read failure |
| Request | selected process key despite mismatch; one store read; one auth request; fresh on every call; timeout signal; redirects rejected |
| Auth | accepted; empty windows; HTTP 401/403/429/500; unexpected HTTP; timeout; network error; provider rejection |
| Response | null/array body; non-JSON; false success; absent/null/array data; missing/wrong limits; wrong entry/numeric types |
| Secrets | response msg reflects either key; exception reflects key/header; all text/JSON/debug paths remain scrubbed |
| Verdict | every row of summary table, mismatch + rejection precedence, optional warnings, online/offline consistency |
| Options | offline zero fetch; conflicting flags exit 2; JSON+network same checks as text; quiet retains failures |
| UI | geometry by visible columns; pipe has no escapes; no color/dumb; no lost path text; unknown/clamped bars |
| Regression | status/usage JSON unchanged; init offline; progress stdout/MCP framing unchanged; budget malformed-data fail-open |

Planned gates: `npm run build`, `npm test`, `npm run lint`.
Manual: built CLI in PowerShell 5.1, PowerShell 7 and CMD; narrow window, redirected
text, `--help`, `doctor --offline`, JSON. Any real monitor check must be read-only,
use configured credentials without displaying them, and record the result separately
from simulated rejection tests. Do not revoke or overwrite a user's real key to test.
