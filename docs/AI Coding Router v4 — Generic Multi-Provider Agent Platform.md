# AI Coding Router v4
## Generic Multi-Provider, Multi-Agent Coding Control Plane

**Target version:** 4.0  
**Base:** v3  
**Primary objective:** Generic hóa toàn bộ router để bất kỳ AI coding provider nào cũng có thể tham gia theo capability.

---

# 1. Product transition

v1:

```text
GLM worker integration
```

v2:

```text
Observable + quota-aware GLM router
```

v3:

```text
Claude / Codex / ZCode role router
```

v4:

```text
AI Coding Router
```

Không còn architecture phụ thuộc ba provider cụ thể.

---

# 2. Core philosophy

Ba nguyên tắc:

```text
Router owns tasks.

Providers lease execution.

Roles are independent of providers.
```

Task là đối tượng bền vững.

Model/provider chỉ là tài nguyên được router lựa chọn.

---

# 3. Kiến trúc tổng thể

```text
                         USER
                           │
                           ▼
                     TASK ENGINE
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
         TaskGraph     Policy Engine   Scheduler
             │             │             │
             └─────────────┼─────────────┘
                           ▼
                     ROUTING ENGINE
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
          Planner        Worker       Reviewer
              │            │            │
              ▼            ▼            ▼
         Provider A   Provider B   Provider C
              │            │            │
              └──── Provider Registry ──┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
       Budget          Handoff        Observability
       Manager         Manager            Engine
```

---

# 4. Generic Provider SDK

Provider chỉ cần implement interface:

```ts
interface CodingProvider {
  manifest:
    ProviderManifest;

  capabilities():
    Promise<ProviderCapabilities>;

  health():
    Promise<ProviderHealth>;

  budget():
    Promise<BudgetState>;

  start(
    lease: ExecutionLease
  ): Promise<ProviderSession>;

  resume?(
    session: ProviderSession,
    input: ResumeInput
  ): Promise<ProviderSession>;

  cancel(
    session: ProviderSession
  ): Promise<void>;

  events(
    session: ProviderSession
  ): AsyncIterable<AgentEvent>;
}
```

---

# 5. Provider Manifest

```json
{
  "id": "anthropic.claude-code",

  "displayName": "Claude Code",

  "version": "1.0",

  "roles": [
    "planner",
    "worker",
    "reviewer",
    "verifier"
  ],

  "execution": {
    "headless": true,
    "streaming": true,
    "nativeResume": true
  },

  "budget": {
    "observable": "estimated"
  }
}
```

---

# 6. Provider registry

Built-in:

```text
Claude Code
Codex
ZCode
```

Optional future:

```text
Gemini CLI
OpenRouter
Ollama
local LLM
Cursor agent
custom MCP
custom CLI
company internal agent
```

---

# 7. Provider installation

Future command:

```text
ai-router provider install <package>
```

Ví dụ:

```text
ai-router provider install @ai-router/gemini
```

List:

```text
ai-router providers
```

Output:

```text
Claude Code      READY
Codex            READY
ZCode            READY
Gemini           READY
Ollama           DISABLED
```

---

# 8. Capability negotiation

Router không hỏi:

```text
"Is this Claude?"
```

Router hỏi:

```text
Can provider:

plan?
write files?
run shell?
stream?
resume?
use MCP?
access web?
report quota?
```

Routing dựa capability.

---

# 9. Generic roles

Core roles:

```text
planner
worker
reviewer
verifier
researcher
```

Custom role future:

```text
security-reviewer
test-writer
frontend-worker
database-reviewer
```

Role chỉ là capability/policy profile.

---

# 10. Workflow definition

v4 hỗ trợ workflow declarative:

```yaml
workflow: feature-development

steps:

  - role: planner

  - role: worker
    parallel: true

  - role: verifier

  - role: reviewer
```

Router chọn provider cho từng step.

---

# 11. Task Graph Engine

Ví dụ:

```text
Implement payment webhook
│
├─ Analyze current payment flow
│
├─ Implement endpoint
│
├─ Implement signature verification
│
├─ Unit tests
│
├─ Integration tests
└─ Final review
```

Dependencies:

```text
Analyze
   ↓
Implementation
   ↓
Tests
   ↓
Review
```

Scheduler có thể parallelize independent nodes.

---

# 12. Scheduler

Scheduler chịu trách nhiệm:

```text
dependency
parallelism
provider availability
quota
cost
worktree isolation
execution leases
retries
handoffs
```

---

# 13. Execution Lease v4

```ts
interface ExecutionLease {
  leaseId: string;

  taskId: string;

  nodeId: string;

  role: string;

  provider: string;

  model?: string;

  workspace: WorkspaceRef;

  budget: LeaseBudget;

  limits: {
    turns?: number;
    durationMs?: number;
  };
}
```

---

# 14. Generic Budget Manager

Budget không giả định token.

Các provider có thể dùng:

```text
tokens
credits
messages
compute time
monthly SDK credit
unknown quota
API dollars
```

Canonical:

```ts
interface BudgetState {
  unit:
    | "token"
    | "credit"
    | "message"
    | "currency"
    | "unknown";

  available?: number;

  limit?: number;

  resetAt?: string;

  confidence:
    | "exact"
    | "estimated"
    | "unknown";

  costClass:
    | "subscription"
    | "prepaid"
    | "payg"
    | "local";
}
```

---

# 15. Policy Engine

Policy không hardcode provider.

Example:

```yaml
policy:

  cost:
    preferSubscription: true
    allowPayg: false

  quality:
    minimumScore: 0.75

  quota:
    reserve: 0.10

  privacy:
    allowRemoteProviders: true

  routing:
    preferLocalForSecrets: false
```

---

# 16. Routing score

```text
score
=
quality
× capability
× availability
× budgetHealth
× policyMatch
÷ expectedCost
```

Provider có score thấp bị skip.

---

# 17. Historical efficiency

Router học thống kê local:

```text
provider
model
role
task category
duration
turns
tokens/credits
validation success
retry count
manual intervention
```

Không cần ML ban đầu.

Rolling statistics đủ.

---

# 18. Adaptive routing

Ví dụ:

```text
Task:
"add CRUD"

History:

ZCode Flash
success 96%
median 35s
cheap

Codex
success 98%
median 28s
expensive quota

Claude
success 98%
median 31s
```

Router ưu tiên:

```text
ZCode Flash
```

Task:

```text
"debug concurrency race"
```

History có thể route:

```text
Codex / Claude
```

---

# 19. Generic Handoff Manager

Handoff không biết model cụ thể.

```text
Provider A
   ↓
Checkpoint
   ↓
Task Snapshot
   ↓
Provider B
```

Provider-independent snapshot chứa:

```text
task
decisions
workspace
diff
completed nodes
pending nodes
validation
constraints
```

---

# 20. Task Snapshot

```json
{
  "taskId": "...",

  "graph": {
    "completed": [],
    "running": [],
    "pending": []
  },

  "workspace": {
    "repo": "...",
    "worktree": "...",
    "branch": "..."
  },

  "changes": {
    "files": []
  },

  "validation": [],

  "decisions": []
}
```

---

# 21. Async job engine

Task lifecycle:

```text
QUEUED
ROUTING
RUNNING
DRAINING
CHECKPOINTING
HANDOFF
VERIFYING
COMPLETED
FAILED
CANCELLED
```

API:

```text
task_start
task_status
task_result
task_cancel
```

---

# 22. MCP integration

Generic MCP tools:

```text
coding_task_start
coding_task_status
coding_task_result
coding_task_cancel

coding_provider_list
coding_provider_status

coding_route_preview
coding_handoff

coding_budget
```

Legacy v1/v3 tools vẫn alias.

---

# 23. MCP Tasks

v4 Task Engine nên map tự nhiên sang MCP Tasks khi host support phù hợp.

Internal lifecycle không phụ thuộc MCP.

MCP chỉ là transport/interface.

---

# 24. Control Plane TUI

Dashboard v4:

```text
╭─ AI Coding Router ─────────────────────────────────╮
│ Project: goldenpen                                 │
╰─────────────────────────────────────────────────────╯

TASKS

● auth-refresh
  Planner   Claude
  Worker    ZCode
  Reviewer  Codex
  State     RUNNING

● reporting
  Planner   Codex
  Worker    Claude
  State     VERIFYING

PROVIDERS

Claude    READY   Budget ?
Codex     READY   Budget 61%
ZCode     READY   Budget 32%

ROUTES

worker/simple     → ZCode Flash
worker/complex    → Codex
review            → Claude
```

---

# 25. Worktree control plane

Scheduler có thể tạo:

```text
Task
├─ backend worktree
├─ frontend worktree
└─ tests worktree
```

Providers khác nhau chạy song song.

Router quản lý:

```text
ownership
branch
merge readiness
conflicts
cleanup
```

Không auto merge nếu policy không cho phép.

---

# 26. Multi-agent execution

Ví dụ:

```text
                 Claude Planner
                       │
            ┌──────────┼──────────┐
            ▼          ▼          ▼
         Codex      ZCode      Claude
        backend    frontend     tests
            │          │          │
            └──────────┼──────────┘
                       ▼
                 Codex Reviewer
```

---

# 27. Conflict prevention

Mỗi write worker mặc định:

```text
own worktree
```

Parallel task cần explicit file ownership hoặc isolated branch.

Không cho:

```text
2 providers
→ same writable tree
```

trừ khi user override.

---

# 28. Security policy

Provider metadata phải khai báo:

```text
remote/local
data retention class
network access
shell access
workspace write
```

Task có thể yêu cầu:

```text
local-only
no-network
read-only
```

Router filter provider trước routing.

---

# 29. Cost safety

Không silent route sang:

```text
paid API
```

nếu task ban đầu dùng subscription.

Policy:

```yaml
cost:
  allowAutomaticUpgrade: false
```

UI:

```text
Task requires fallback.

Next available:
Claude API
Estimated cost: $1.20–$2.10

Continue? Y/N
```

---

# 30. Provider health

Health:

```text
READY
DEGRADED
RATE_LIMITED
EXHAUSTED
OFFLINE
MISCONFIGURED
```

Routing tránh provider không healthy.

---

# 31. Circuit breaker

Nếu provider fail liên tục:

```text
3 failures / 5 min
```

→ circuit open.

```text
Provider temporarily removed from routing.
```

Sau cooldown:

```text
half-open health probe
```

---

# 32. Retry policy

Không retry vô hạn.

```yaml
retry:
  maxProviderRetries: 2
  maxTaskRetries: 5
```

Sau provider retry:

```text
handoff
```

---

# 33. Observability v4

Unified events:

```text
task.created
route.selected
lease.started
provider.started
tool.started
tool.completed
budget.warning
checkpoint.created
handoff.started
handoff.completed
validation.completed
task.completed
```

Mọi provider adapter normalize vào event model này.

---

# 34. Event storage

Local-first:

```text
~/.ai-coding-router/
runs/
tasks/
events/
metrics/
```

Không cloud telemetry mặc định.

---

# 35. Plugin SDK

Package future:

```text
@ai-coding-router/sdk
```

Exports:

```ts
defineProvider()
defineRole()
definePolicy()
defineWorkflow()
```

Developer có thể viết provider mới mà không sửa core.

---

# 36. CLI future

Canonical:

```text
ai-router
```

Commands:

```text
ai-router init

ai-router providers
ai-router roles
ai-router routes

ai-router task run
ai-router task status
ai-router task cancel

ai-router dashboard

ai-router budget

ai-router workflow run
```

---

# 37. Backward compatibility

Giữ package/commands cũ:

```text
glm-router
glm-worker
glm-review
glm-fast
glm-mcp
```

Mapping sang new core.

Ví dụ:

```text
glm-worker
=
ai-router task run
role=worker
provider=zcode
```

---

# 38. Product rename strategy

Không rename package ngay đầu v4.

Giai đoạn đầu:

```text
glm-coding-router
powered by AI Coding Router Core
```

Sau khi generic provider ecosystem ổn định mới cân nhắc:

```text
ai-coding-router
```

---

# 39. Code architecture v4

```text
src/
├── core/
│   ├── task-engine/
│   ├── scheduler/
│   ├── routing/
│   ├── policy/
│   ├── budget/
│   ├── handoff/
│   └── observability/
│
├── sdk/
│   ├── provider.ts
│   ├── role.ts
│   ├── workflow.ts
│   └── policy.ts
│
├── providers/
│   ├── claude/
│   ├── codex/
│   └── zcode/
│
├── transport/
│   ├── cli/
│   ├── mcp/
│   └── tui/
│
└── compatibility/
    ├── glm-worker.ts
    ├── glm-review.ts
    └── glm-router.ts
```

---

# 40. Migration from v3

Step 1:

```text
extract Provider SDK
```

Step 2:

```text
move Claude/Codex/ZCode adapters
behind SDK
```

Step 3:

```text
replace hardcoded role types
with registry roles
```

Step 4:

```text
extract Policy Engine
```

Step 5:

```text
extract Workflow Engine
```

Step 6:

```text
add external provider loading
```

---

# 41. Acceptance criteria v4

```text
✓ Core has no direct Claude-specific routing logic
✓ Core has no direct Codex-specific routing logic
✓ Core has no direct ZCode-specific routing logic

✓ Providers implement common SDK

✓ New provider can be added without modifying TaskEngine

✓ Roles can be mapped to arbitrary providers

✓ Router can hand off task between arbitrary providers

✓ Budget can represent token/credit/message/currency/unknown

✓ TaskGraph survives provider replacement

✓ parallel isolated workers supported

✓ policy engine controls routing

✓ billing escalation requires consent

✓ unified observability works for all providers

✓ MCP generic task lifecycle works

✓ legacy GLM commands remain compatible
```

---

# 42. v4 Definition of Done

Example scenario:

```text
Planner:
Codex

Worker 1:
ZCode

Worker 2:
Claude

Reviewer:
Provider X
```

ZCode quota exhausted.

Router:

```text
checkpoint
↓
handoff
↓
Claude
```

Claude becomes unavailable.

Router:

```text
checkpoint
↓
route preview
↓
Provider X
```

Task remains:

```text
same task ID
same TaskGraph
same workspace state
same history
```

No restart from scratch.

---

# 43. Final product state

v4 product should be understood as:

```text
AI Coding Control Plane
```

responsible for:

```text
who plans
who executes
who reviews
who has quota
who is healthy
who is cheapest
who satisfies policy
who takes over
```

The user defines goals and policy.

The router owns execution.

Providers become interchangeable resources.