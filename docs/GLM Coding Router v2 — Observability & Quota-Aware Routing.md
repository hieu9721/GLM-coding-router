# GLM Coding Router v2
## Observability, Terminal UX & Quota-Aware Routing Core

**Target version:** 2.0  
**Base:** v1.0  
**Primary objective:** Quan sát được worker + tối ưu quota GLM + handoff an toàn về orchestrator hiện tại.

---

# 1. Mục tiêu

v2 giải quyết ba vấn đề:

1. Người dùng không quan sát được `glm-worker` đang thực sự làm gì.
2. CLI hiện hoạt động tốt nhưng UX vẫn thiên về command → output → exit.
3. GLM quota có thể cạn giữa task nhưng router chưa có cơ chế chủ động giảm tải hoặc bàn giao.

v2 **chưa** biến Claude/Codex/ZCode thành các provider có thể đảo vai trò tùy ý.

Kiến trúc vẫn là:

```text
Claude Code / Codex
        │
        │ orchestrator cố định
        ▼
     Router
        │
        ▼
   GLM Worker
```

Nhưng worker trở thành một observable job có:

```text
Run ID
State
Timeline
Budget
Checkpoint
Metrics
Result
```

---

# 2. Scope v2

Bao gồm:

```text
WorkerEvent model
Run Registry
Run History
Claude stream-json parser
Terminal live progress
glm-router watch
glm-router dashboard
glm-router runs
quota monitor
budget zones
Flash/Main routing
preflight budget check
basic task-cost estimation
checkpoint
basic graceful handoff
```

Không bao gồm:

```text
Claude làm worker
Codex làm worker
ZCode làm planner
role inversion
generic provider SDK
multi-provider scheduler
parallel provider execution
```

---

# 3. Kiến trúc

```text
                 Claude / Codex
                    Orchestrator
                         │
                         ▼
                 Routing Core v2
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
        Budget Manager         Run Manager
              │                     │
              ▼                     ▼
       GLM Main / Flash       Event Registry
              │                     │
              └──────────┬──────────┘
                         ▼
                     GLM Worker
                         │
                         ▼
                Claude stream-json
                         │
                         ▼
                  Event Adapter
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
      Terminal       Run History     Dashboard
```

---

# 4. Worker Event Model

Tạo canonical event:

```ts
type WorkerEvent =
  | RunStarted
  | AgentInitialized
  | TurnStarted
  | ToolStarted
  | ToolCompleted
  | FileChanged
  | ValidationStarted
  | ValidationCompleted
  | ApiRetry
  | BudgetWarning
  | CheckpointCreated
  | HandoffStarted
  | HandoffCompleted
  | RunCompleted
  | RunFailed
  | RunCancelled
  | Heartbeat;
```

UI không parse trực tiếp Claude JSON.

Flow:

```text
Claude stream-json
        ↓
ClaudeEventAdapter
        ↓
WorkerEvent
        ↓
Renderer / Store / MCP
```

---

# 5. Run identity

Mọi worker invocation có Run ID:

```text
run_01K6P4F...
```

Run metadata:

```json
{
  "id": "run_01K6P4F",
  "kind": "worker",
  "provider": "glm",
  "model": "glm-5.3",
  "status": "running",
  "cwd": "D:\\Projects\\goldenpen",
  "startedAt": "...",
  "parent": {
    "type": "claude"
  }
}
```

---

# 6. Run Registry

Storage:

```text
~/.glm-coding-router/
└── runs/
    ├── active/
    │   └── run_01K6....json
    │
    └── history/
        └── 2026-09-18/
            └── run_01K6.../
                ├── events.jsonl
                ├── summary.json
                └── checkpoint.json
```

Không lưu mặc định:

```text
API key
full source code
full prompt
full LLM response
Authorization header
```

---

# 7. Live progress

Direct terminal:

```text
╭─ GLM Worker ─────────────────────────────╮
│ Run      #P4F                            │
│ Model    GLM-5.3                         │
│ Project  goldenpen                       │
╰──────────────────────────────────────────╯

● Connected
● Agent initialized

◉ Turn 1
  ├─ Read  auth/service.go
  ├─ Read  auth/repository.go
  └─ Grep  RefreshToken

◉ Turn 2
  ├─ Edit  auth/service.go
  └─ Write auth/service_test.go

◉ Turn 3
  └─ Bash  go test ./internal/auth/...

✓ Completed

Duration   43.2s
Turns      3
Files      2
```

Nested mode:

```text
[GLM] ● #P4F started • GLM-5.3
[GLM] turn 1 • exploring auth
[GLM] turn 2 • editing 2 files
[GLM] turn 3 • running tests
[GLM] ✓ #P4F • 43s • 3 turns
```

Progress dùng `stderr`.

Final response dùng `stdout`.

---

# 8. TUI commands

Thêm:

```text
glm-router dashboard
glm-router watch [run-id]
glm-router runs
glm-router runs show <id>
glm-router runs logs <id>
glm-router runs clean
```

`dashboard` hiển thị:

```text
Quota
Active Runs
Recent Runs
Current model
Duration
Turns
Files changed
Worktree
Errors
```

---

# 9. UI technology

Khuyến nghị:

```text
React
+
Ink
```

Chỉ lazy-load Ink cho TUI.

Các command:

```text
status
doctor
usage
benchmark
```

giữ line-oriented hiện tại.

---

# 10. Quota-Aware Routing Core

v2 thêm một `BudgetManager`.

```ts
interface BudgetSnapshot {
  provider: "glm";

  fiveHour: {
    used: number;
    limit: number;
    remainingRatio: number;
    resetAt?: string;
  };

  weekly: {
    used: number;
    limit: number;
    remainingRatio: number;
    resetAt?: string;
  };

  confidence: "exact";
}
```

Nguồn hiện tại:

```text
Z.ai monitor quota endpoint
```

Project đã xác nhận quota monitor thực tế hoạt động và phân biệt được 5h / weekly window.

---

# 11. Budget zones

Default visualization:

```text
HEALTHY
>30%

CONSERVE
15–30%

HANDOFF READY
8–15%

CRITICAL
<8%
```

Nhưng routing không chỉ dựa percentage.

Công thức:

```text
usableBudget
=
remainingBudget
-
reserveBudget
```

Sau đó:

```text
estimatedRemainingCost × safetyFactor
>
usableBudget
```

→ không tiếp tục provider hiện tại.

Default:

```text
reserveRatio = 10%
safetyFactor = 1.3
```

---

# 12. GLM model routing

Default:

```text
HEALTHY
→ GLM-5.3

CONSERVE
→ prefer GLM-5.3-Flash

HANDOFF READY
→ new task ưu tiên Flash

CRITICAL
→ không cấp task mới cho GLM
```

Override:

```text
glm-worker --model main
glm-worker --model fast
```

---

# 13. Task cost estimator

v2 dùng estimator đơn giản.

Nguồn:

```text
model
profile
task type
repository
historical runs
```

Ví dụ:

```text
backend CRUD
glm-main

p50 = 42 credits
p90 = 66 credits
```

Preflight sử dụng:

```text
p90
```

Nếu chưa đủ data:

```text
default baseline
```

---

# 14. Preflight routing

Trước GLM run:

```text
Task estimate: 90 credits
Available usable budget: 50 credits
```

Router không khởi động GLM Main.

Có thể:

```text
route GLM Flash
```

Nếu Flash cũng không đủ:

```text
return task to current orchestrator
```

UI:

```text
[Router] GLM skipped
[Router] estimated cost 90
[Router] usable quota 50
[Router] returning task to Claude
```

---

# 15. Basic graceful handoff

v2 chỉ hỗ trợ:

```text
GLM worker
→ parent orchestrator
```

Không hỗ trợ:

```text
Claude worker → Codex worker
```

đó là v3.

Flow:

```text
GLM
 │
 │ budget low
 ▼
DRAINING
 │
 ▼
CHECKPOINT
 │
 ▼
HANDOFF BUNDLE
 │
 ▼
Parent Claude/Codex
```

---

# 16. Checkpoint

Tạo sau:

```text
TurnCompleted
ToolCompleted quan trọng
ValidationCompleted
```

`checkpoint.json`:

```json
{
  "runId": "...",
  "phase": "implementation",

  "completed": [
    "analyzed auth service",
    "implemented validation"
  ],

  "pending": [
    "write tests",
    "run test suite"
  ],

  "filesChanged": [
    "internal/auth/service.go"
  ],

  "validationPending": [
    "go test ./internal/auth/..."
  ]
}
```

---

# 17. Handoff Bundle v2

Tạo:

```text
handoff.json
handoff.md
diff.patch
checkpoint.json
```

Không phụ thuộc GLM tự viết summary.

Router tự xây từ:

```text
Task spec
Worker events
Git diff
Checkpoint
Validation history
```

---

# 18. Parent handoff result

GLM worker trả:

```json
{
  "status": "handoff_required",
  "run_id": "run_P4F",

  "reason": "quota_low",

  "completed": [
    "implemented token validation"
  ],

  "pending": [
    "tests"
  ],

  "handoff_path": ".../handoff.md"
}
```

Claude/Codex tiếp tục cùng worktree.

---

# 19. Safe handoff boundary

Không stop:

```text
giữa Edit
giữa Write
giữa shell command
```

State:

```text
RUNNING
  ↓ quota warning
DRAINING
  ↓ next safe boundary
CHECKPOINTING
  ↓
HANDOFF
```

Safe boundary:

```text
ToolCompleted
TurnCompleted
```

---

# 20. v2 state machine

```text
QUEUED
  ↓
PREFLIGHT
  ↓
RUNNING
  ├──────── completed ────────→ VERIFYING
  │
  └ quota low
       ↓
    DRAINING
       ↓
    CHECKPOINT
       ↓
     HANDOFF
       ↓
    PARENT
```

---

# 21. Config v2

```json
{
  "routing": {
    "quotaAware": true,

    "reserveRatio": 0.10,

    "safetyFactor": 1.3,

    "preferFlashBelow": 0.30,

    "handoffReadyBelow": 0.15,

    "criticalBelow": 0.08
  },

  "history": {
    "retentionDays": 30,
    "maxRuns": 1000
  },

  "ui": {
    "mode": "auto",
    "color": true
  }
}
```

---

# 22. Code layout v2

```text
src/
├── events/
│   ├── types.ts
│   ├── bus.ts
│   └── claude-adapter.ts
│
├── runs/
│   ├── registry.ts
│   ├── store.ts
│   ├── checkpoint.ts
│   └── heartbeat.ts
│
├── budget/
│   ├── manager.ts
│   └── estimator.ts
│
├── routing/
│   └── glm-routing.ts
│
├── handoff/
│   ├── bundle.ts
│   └── parent-handoff.ts
│
└── tui/
    ├── dashboard.tsx
    ├── watch.tsx
    └── runs.tsx
```

---

# 23. Acceptance criteria v2

v2 hoàn thành khi:

```text
✓ GLM worker có Run ID
✓ progress hiển thị realtime
✓ dashboard hoạt động
✓ watch attach được active run
✓ run history tồn tại
✓ quota hiện realtime
✓ Main → Flash routing hoạt động
✓ preflight không khởi chạy GLM nếu quota không đủ
✓ active GLM run checkpoint được
✓ quota-low run bàn giao về parent orchestrator
✓ không mất working tree changes
✓ stdout compatibility giữ nguyên
✓ MCP stdout không bị TUI pollute
✓ v1 command backward compatible
```

---

# 24. Kết quả v2

Sau v2:

```text
GLM Coding Router
=
Observable GLM execution layer
+
Quota-aware worker router
```

Chưa phải multi-provider router.

Đó là nhiệm vụ của v3.