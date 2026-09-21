# GLM Coding Router v3
## Tri-Agent Role Switching Architecture

**Target version:** 3.0  
**Base:** v2  
**Primary objective:** Cho phép Claude Code, Codex và ZCode/GLM hoán đổi vai trò Planner / Worker / Reviewer.

---

# 1. Định nghĩa quan trọng

Claude Code, Codex và ZCode không nên được coi là “ba model”.

Trong architecture v3, chúng là ba:

```text
Execution Stacks / Providers
```

Provider IDs:

```text
anthropic.claude-code
openai.codex
zai.zcode
```

Mỗi provider có thể expose nhiều model.

Ví dụ:

```text
zai.zcode
├── GLM-5.3
└── GLM-5.3-Flash
```

---

# 2. Mục tiêu

Cho phép:

```text
Claude planner
→ GLM worker
→ Claude reviewer
```

hoặc:

```text
Codex planner
→ Claude worker
→ Codex reviewer
```

hoặc:

```text
ZCode planner
→ Codex worker
→ Claude reviewer
```

hoặc:

```text
Claude planner
→ Codex worker
→ ZCode reviewer
```

Role và provider phải độc lập.

---

# 3. Core principle

Không còn:

```text
Claude = planner
GLM = worker
```

Mà là:

```text
Role
+
Provider
```

Role:

```ts
type AgentRole =
  | "planner"
  | "worker"
  | "reviewer"
  | "verifier";
```

Provider:

```ts
type ProviderId =
  | "anthropic.claude-code"
  | "openai.codex"
  | "zai.zcode";
```

---

# 4. Kiến trúc

```text
                         USER
                           │
                           ▼
                      TASK ENGINE
                           │
                           ▼
                     ROLE ENGINE
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
       Planner           Worker          Reviewer
          │                │                │
          ▼                ▼                ▼
     Provider A       Provider B       Provider C
          │                │                │
          └───────────── Router ────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
           Budget       Handoff      Run Registry
```

---

# 5. Provider abstraction

```ts
interface AgentProvider {
  id: string;

  capabilities():
    ProviderCapabilities;

  health():
    Promise<ProviderHealth>;

  budget():
    Promise<BudgetState>;

  start(
    spec: AgentRunSpec
  ): Promise<AgentSession>;

  resume(
    session: AgentSession,
    input: ResumeInput
  ): Promise<AgentSession>;

  cancel(
    session: AgentSession
  ): Promise<void>;

  events(
    session: AgentSession
  ): AsyncIterable<AgentEvent>;
}
```

Router không gọi trực tiếp:

```text
claude.exe
codex.exe
Z.ai endpoint
```

Core chỉ biết `AgentProvider`.

---

# 6. Provider adapters

v3 triển khai:

```text
ClaudeCodeProvider
CodexProvider
ZCodeProvider
```

---

# 7. ClaudeCodeProvider

Capabilities:

```text
interactive
headless
streaming
session resume
tool use
write
read-only
MCP
```

Execution:

```text
claude -p
```

Streaming:

```text
stream-json
```

Resume:

```text
session ID
```

---

# 8. CodexProvider

Execution:

```text
codex exec
```

Event mode:

```text
codex exec --json
```

Resume:

```text
codex exec resume
```

Adapter normalize Codex events thành canonical `AgentEvent`.

---

# 9. ZCodeProvider

ZCode provider đại diện cho:

```text
Z.ai execution stack
```

Có thể dùng:

```text
ZCode native agent
```

hoặc compatibility layer hiện có.

Model:

```text
GLM-5.3
GLM-5.3-Flash
```

Quota:

```text
Z.ai Coding Plan
```

---

# 10. Provider capabilities

```ts
interface ProviderCapabilities {
  planner: boolean;

  worker: boolean;

  reviewer: boolean;

  verifier: boolean;

  streaming: boolean;

  nativeResume: boolean;

  write: boolean;

  readOnly: boolean;

  mcp: boolean;

  quotaObservable:
    "exact" |
    "estimated" |
    "unknown";
}
```

Role Engine chỉ route role sang provider support capability tương ứng.

---

# 11. Role configuration

```yaml
roles:

  planner:
    primary: anthropic.claude-code
    fallback:
      - openai.codex
      - zai.zcode

  worker:
    primary: zai.zcode
    fallback:
      - openai.codex
      - anthropic.claude-code

  reviewer:
    primary: anthropic.claude-code
    fallback:
      - openai.codex
```

---

# 12. Role inversion

User muốn:

```text
Codex plan
Claude worker
Codex review
```

Config:

```yaml
roles:

  planner:
    primary: openai.codex

  worker:
    primary: anthropic.claude-code

  reviewer:
    primary: openai.codex
```

Không thay core.

---

# 13. Runtime role switching

Có thể command:

```text
glm-router roles show
```

Output:

```text
Planner   Claude Code
Worker    ZCode / GLM-5.3
Reviewer  Claude Code
```

Switch:

```text
glm-router roles set planner codex
glm-router roles set worker claude
glm-router roles set reviewer codex
```

Temporary override:

```text
glm-router run \
  --planner codex \
  --worker claude \
  --reviewer codex
```

---

# 14. Task ownership

v3 thay đổi ownership model.

Không còn:

```text
provider owns task
```

Mà:

```text
Router owns task
```

Provider chỉ nhận:

```text
Execution Lease
```

---

# 15. Execution Lease

```ts
interface ExecutionLease {
  taskId: string;

  provider: ProviderId;

  role: AgentRole;

  model?: string;

  maxTurns?: number;

  maxDurationMs?: number;

  budgetLimit?: number;
}
```

Sau lease:

```text
checkpoint
```

Router quyết định:

```text
renew
switch
complete
```

---

# 16. Task Graph

Task không còn là string duy nhất.

```text
Feature Auth
│
├─ Analyze architecture       DONE
├─ Implement service          DONE
├─ Implement tests            RUNNING
├─ Integration test           PENDING
└─ Final review               PENDING
```

Model planner có thể thay đổi giữa task nhưng TaskGraph không mất.

---

# 17. Handoff Bundle v3

Provider-independent:

```text
handoff.json
handoff.md
checkpoint.json
diff.patch
events.jsonl
```

Schema thêm:

```json
{
  "from": {
    "provider": "zai.zcode",
    "role": "worker"
  },

  "to": {
    "provider": "openai.codex",
    "role": "worker"
  }
}
```

---

# 18. Same workspace principle

Cross-provider handoff giữ:

```text
same worktree
same branch
same uncommitted changes
same task ID
```

Không restart task.

---

# 19. Cross-provider continuation

Provider B nhận:

```text
task spec
checkpoint
handoff summary
git diff
pending validations
```

Prompt system:

```text
You are continuing an existing task.

Do not restart the task.

Inspect the current workspace first.

Read checkpoint and handoff metadata.

Continue from PENDING work only.
```

---

# 20. Budget abstraction

v3 generic hóa BudgetManager.

```ts
interface BudgetState {
  provider: ProviderId;

  source:
    | "exact"
    | "estimated"
    | "unknown";

  remainingRatio?: number;

  remainingUnits?: number;

  resetAt?: string;

  costClass:
    | "included-plan"
    | "prepaid"
    | "api-payg"
    | "unknown";
}
```

---

# 21. Billing safety

Không tự chuyển:

```text
subscription
→ API pay-as-you-go
```

Config:

```yaml
billing:
  allowAutomaticCostClassChange: false
```

Nếu route yêu cầu tăng cost class:

```text
ASK USER
```

---

# 22. Route graph

Ví dụ worker:

```text
ZCode Flash
     │
     │ complex task
     ▼
ZCode Main
     │
     │ quota low
     ▼
Codex
     │
     │ unavailable
     ▼
Claude
```

Planner:

```text
Claude
  ↓ quota unavailable
Codex
  ↓ unavailable
ZCode
```

---

# 23. Route scoring

Rule-based:

```text
score
=
qualityWeight
× capabilityMatch
× budgetHealth
× availability
÷ costWeight
```

Không ML trong v3.

---

# 24. Quality escalation

Không chỉ quota.

Ví dụ:

```text
ZCode Flash
   ↓
test fail
   ↓ retry
test fail
   ↓
ZCode Main
   ↓
test fail
   ↓
Codex
```

Config:

```yaml
quality:
  maxRetriesPerProvider: 2
  escalateOnValidationFailure: true
```

---

# 25. Planner handoff

Planner cũng có checkpoint.

Planner state:

```text
requirements
architecture decisions
task graph
completed workers
pending workers
review notes
```

Nếu Claude planner unavailable:

```text
Claude
 ↓
Planner Bundle
 ↓
Codex
```

Codex tiếp quản TaskGraph.

---

# 26. Generic MCP layer

v1 commands:

```text
glm_worker
glm_review
glm_delegate
glm_usage
```

v3 thêm:

```text
agent_run
agent_review
agent_status
agent_handoff
agent_cancel

router_roles
router_routes
router_budget
```

Legacy mapping:

```text
glm_worker
→ agent_run(provider=zai.zcode)
```

---

# 27. Generic CLI

Thêm:

```text
glm-router providers
glm-router roles
glm-router routes
glm-router handoff
glm-router task
```

Ví dụ:

```text
glm-router providers status
glm-router roles show
glm-router routes show
glm-router handoff <task-id> --to codex
```

---

# 28. Dashboard v3

```text
TASK auth-refresh

Planner
● Claude Code

Worker
● ZCode / GLM-5.3

Reviewer
○ Codex

Worker Budget
GLM 5h 12%

State
HANDOFF READY
```

Timeline:

```text
14:31 ZCode worker started
14:33 quota warning
14:33 checkpoint
14:34 worker → Codex
14:35 tests passed
14:36 Claude review
```

---

# 29. Config v3

```yaml
providers:

  claude:
    adapter: claude-code

  codex:
    adapter: codex-cli

  zcode:
    adapter: zai-zcode


roles:

  planner:
    primary: claude

  worker:
    primary: zcode
    fallback:
      - codex
      - claude

  reviewer:
    primary: claude
    fallback:
      - codex


handoff:
  mode: auto
  preserveWorkspace: true
  safeBoundary: true


billing:
  allowAutomaticCostClassChange: false
```

---

# 30. Code layout v3

```text
src/
├── providers/
│   ├── base.ts
│   ├── claude.ts
│   ├── codex.ts
│   └── zcode.ts
│
├── roles/
│   ├── engine.ts
│   └── policy.ts
│
├── tasks/
│   ├── graph.ts
│   ├── lease.ts
│   └── state.ts
│
├── routing/
│   ├── engine.ts
│   ├── scoring.ts
│   └── routes.ts
│
├── handoff/
│   ├── bundle.ts
│   ├── manager.ts
│   └── checkpoint.ts
│
└── budget/
    ├── manager.ts
    └── providers/
```

---

# 31. Migration from v2

Không rewrite v2.

Mapping:

```text
GLM routing
→ ZCodeProvider

Claude parent
→ ClaudeCodeProvider

Codex parent
→ CodexProvider

v2 Checkpoint
→ provider-independent Checkpoint

v2 RunRegistry
→ shared Task/Run Registry
```

---

# 32. Acceptance criteria v3

```text
✓ Claude can be planner
✓ Claude can be worker
✓ Claude can be reviewer

✓ Codex can be planner
✓ Codex can be worker
✓ Codex can be reviewer

✓ ZCode can be planner
✓ ZCode can be worker
✓ ZCode can be reviewer

✓ role config persists
✓ temporary role override works
✓ cross-provider checkpoint works
✓ same worktree preserved
✓ planner handoff works
✓ worker handoff works
✓ reviewer fallback works
✓ billing safety enforced
✓ dashboard shows all roles
✓ v2 GLM-only commands remain compatible
```

---

# 33. Kết quả v3

Sau v3:

```text
GLM Coding Router
=
Tri-provider Coding Router
```

Router đã không còn phụ thuộc:

```text
GLM = worker
```

nhưng vẫn chỉ support ba execution stack được tích hợp sẵn.

Generic extensibility hoàn chỉnh là v4.