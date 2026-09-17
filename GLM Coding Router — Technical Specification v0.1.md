# GLM Coding Router
## Technical Specification v0.1

**Working package name:** `glm-coding-router`  
**CLI name:** `glm-router`  
**Target release:** v0.1.0  
**Primary platform:** Windows 10/11  
**Runtime:** Node.js >= 20  
**Language:** TypeScript  
**Package manager/distribution:** npm

---

# 1. Tổng quan

GLM Coding Router là công cụ CLI giúp kết hợp:

- Claude Code làm orchestrator chính.
- Codex làm orchestrator thay thế hoặc benchmark song song.
- GLM Coding Plan làm worker execution layer.
- Claude/Codex giữ trách nhiệm reasoning, architecture, review và integration.
- GLM đảm nhiệm implementation, exploration, testing, boilerplate và các task có scope rõ.

Mục tiêu của tool là biến setup thủ công:

```text
Claude / Codex
      ↓
shell
      ↓
glm-worker
      ↓
Claude Code harness
      ↓
Z.ai Anthropic-compatible endpoint
      ↓
GLM Coding Plan
```

thành một workflow có thể cài đặt bằng một command.

Z.ai hiện cung cấp Anthropic-compatible endpoint:

```text
https://api.z.ai/api/anthropic
```

cho Coding Plan và OpenAI-compatible coding endpoint:

```text
https://api.z.ai/api/coding/paas/v4
```

cho coding integrations sử dụng protocol OpenAI.

---

# 2. Product goals

## 2.1 Primary goals

Tool phải cho phép user sau khi cài đặt sử dụng:

```powershell
claude
codex

glm-chat
glm-worker "task"
glm-review "task"
```

mà không phải tự tạo `.cmd`.

Tool phải:

1. Quản lý GLM Coding Plan integration.
2. Không phá Claude Code authentication hiện tại.
3. Không thay đổi Codex authentication hiện tại.
4. Không yêu cầu Anthropic API pay-as-you-go.
5. Không yêu cầu OpenAI API pay-as-you-go.
6. Không yêu cầu GLM General API.
7. Không yêu cầu LiteLLM hoặc proxy.
8. Hoạt động trong PowerShell thông thường và terminal chạy bên trong Orca.
9. Tự xử lý stale environment của Orca.
10. Có khả năng uninstall sạch.

---

# 3. Non-goals v0.1

Không triển khai trong v0.1:

```text
Linux installer
macOS installer
GUI application
LLM gateway
MCP server
automatic multi-worktree orchestration
parallel GLM workers
GLM API pay-as-you-go
Anthropic API routing
OpenAI API routing
cloud synchronization
telemetry
usage billing aggregation
automatic Git commits
```

Các phần trên để dành cho roadmap.

---

# 4. Kiến trúc

```text
                         Developer
                             │
             ┌───────────────┴───────────────┐
             │                               │
             ▼                               ▼
       Claude Code                         Codex
     Claude subscription                ChatGPT quota
             │                               │
             └───────────────┬───────────────┘
                             │
                        shell command
                             │
             ┌───────────────┼───────────────┐
             │               │               │
             ▼               ▼               ▼
         glm-chat        glm-worker      glm-review
             │               │               │
             └───────────────┼───────────────┘
                             │
                       claude.exe
                             │
              injected environment only
                             │
                             ▼
              https://api.z.ai/api/anthropic
                             │
                             ▼
                    GLM Coding Plan
                             │
                ┌────────────┴────────────┐
                ▼                         ▼
             GLM-5.3              GLM-5.3-Flash
```

Z.ai hiện liệt kê GLM-5.3 và GLM-5.3-Flash trong Coding Plan.

---

# 5. Thiết kế package

Package npm cung cấp trực tiếp bốn binary:

```json
{
  "bin": {
    "glm-router": "./dist/cli.js",
    "glm-chat": "./dist/bin/glm-chat.js",
    "glm-worker": "./dist/bin/glm-worker.js",
    "glm-review": "./dist/bin/glm-review.js"
  }
}
```

Sau:

```powershell
npm install -g glm-coding-router
```

npm tự expose:

```text
glm-router
glm-chat
glm-worker
glm-review
```

Không cần tự thêm:

```text
C:\Tools
```

vào PATH nữa.

---

# 6. Installation UX

## 6.1 Primary installation

```powershell
npm install -g glm-coding-router
```

sau đó:

```powershell
glm-router init
```

Alternative:

```powershell
npx glm-coding-router init
```

Tuy nhiên `npx` chỉ phù hợp setup/check. Để có `glm-worker` global lâu dài, recommend global install.

---

# 7. `glm-router init`

Wizard dự kiến:

```text
GLM Coding Router v0.1.0

Environment

✓ Windows 11
✓ Node.js 24.x
✓ Git detected
✓ Claude Code detected
✓ Codex detected

Configuration

? Configure Z.ai Coding Plan key? Yes
? Install Claude integration? Yes
? Install Codex integration? Yes
? Install Codex delegation skill? Yes

Installing...

✓ ZAI_API_KEY configured
✓ GLM commands available
✓ Claude integration ready
✓ Codex integration ready
✓ Codex skill installed

Setup complete.

Run:

  glm-router doctor
```

---

# 8. CLI command specification

Main CLI:

```text
glm-router init
glm-router doctor
glm-router status
glm-router config
glm-router key set
glm-router key check
glm-router project init
glm-router project remove
glm-router skill install
glm-router skill remove
glm-router uninstall
```

Global flags:

```text
--json
--quiet
--verbose
--dry-run
--force
--yes
```

---

# 9. `glm-router doctor`

Mục đích: kiểm tra toàn bộ runtime.

Output:

```text
GLM Coding Router Doctor

System
  ✓ Windows 11
  ✓ Node.js 24.1
  ✓ PowerShell 7.6
  ✓ Git 2.x

Agents
  ✓ Claude Code
      C:\...\claude.exe

  ✓ Codex
      C:\...\codex.exe

Z.ai
  ✓ ZAI_API_KEY configured
  ✓ Anthropic endpoint configured
  ✓ Coding Plan credentials available

Commands
  ✓ glm-chat
  ✓ glm-worker
  ✓ glm-review

Claude
  ✓ Integration installed

Codex
  ✓ AGENTS.md integration
  ✓ Delegation skill installed

Environment
  ⚠ Current process does not contain ZAI_API_KEY
  ✓ Windows User Environment contains ZAI_API_KEY

  This is safe. GLM workers reload the key automatically.

Status: HEALTHY
```

Doctor không được hiển thị API key.

---

# 10. Stale environment / Orca handling

Đây là requirement bắt buộc.

Trên Windows:

```text
Orca started
      ↓
Windows environment snapshot
      ↓
ZAI_API_KEY added later
      ↓
Orca terminal cannot see it
```

Do đó hàm:

```ts
resolveZaiApiKey()
```

phải sử dụng thứ tự:

```text
1. process.env.ZAI_API_KEY

2. Windows User Environment

3. fail
```

Implementation Windows:

```ts
import { execFileSync } from "node:child_process";

export function readWindowsUserEnv(name: string): string | undefined {
  try {
    const result = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Environment]::GetEnvironmentVariable('${name}','User')`
      ],
      {
        encoding: "utf8",
        windowsHide: true
      }
    );

    const value = result.trim();

    return value || undefined;
  } catch {
    return undefined;
  }
}
```

Không cache key vào file.

---

# 11. Key management

## Command

```powershell
glm-router key set
```

Prompt:

```text
Enter Z.ai Coding Plan API key:

**********************

✓ Saved to Windows User Environment:
  ZAI_API_KEY
```

Store bằng:

```powershell
[Environment]::SetEnvironmentVariable(
    "ZAI_API_KEY",
    "...",
    "User"
)
```

CLI phải:

- không log key;
- không đưa key vào stack trace;
- không ghi vào config.json;
- không ghi vào repo;
- không ghi vào analytics.

Command:

```powershell
glm-router key check
```

Output:

```text
ZAI_API_KEY: configured
Source: Windows User Environment
```

---

# 12. Runtime environment injection

Mỗi lần chạy GLM command, process con nhận environment riêng:

```ts
const childEnv = {
  ...process.env,

  ANTHROPIC_API_KEY: "",

  ANTHROPIC_AUTH_TOKEN: zaiKey,

  ANTHROPIC_BASE_URL:
    "https://api.z.ai/api/anthropic",

  API_TIMEOUT_MS:
    "3000000",

  ENABLE_CLAUDEAI_MCP_SERVERS:
    "false",

  ANTHROPIC_DEFAULT_OPUS_MODEL:
    config.models.main,

  ANTHROPIC_DEFAULT_SONNET_MODEL:
    config.models.main,

  ANTHROPIC_DEFAULT_HAIKU_MODEL:
    config.models.fast
};
```

Environment này chỉ được truyền vào:

```text
claude.exe child process
```

Không modify parent shell.

---

# 13. Model configuration

Default:

```json
{
  "models": {
    "main": "glm-5.3",
    "fast": "glm-5.3-flash"
  }
}
```

Không hardcode model names ở nhiều chỗ.

Tất cả lấy từ config.

Config path:

```text
%USERPROFILE%\.glm-coding-router\config.json
```

Ví dụ:

```json
{
  "schemaVersion": 1,

  "provider": {
    "name": "zai",
    "anthropicBaseUrl": "https://api.z.ai/api/anthropic"
  },

  "models": {
    "main": "glm-5.3",
    "fast": "glm-5.3-flash"
  },

  "worker": {
    "maxTurns": 20
  },

  "review": {
    "maxTurns": 15
  }
}
```

---

# 14. `glm-chat`

Command:

```powershell
glm-chat
```

Behavior:

```text
resolve ZAI key
     ↓
detect claude.exe
     ↓
inject Z.ai env
     ↓
spawn claude.exe interactively
```

Node implementation concept:

```ts
spawn(claudePath, process.argv.slice(2), {
  stdio: "inherit",
  env: createGlmEnv()
});
```

Phải support:

```powershell
glm-chat
```

và:

```powershell
glm-chat --version
```

và mọi Claude CLI flag khác.

---

# 15. `glm-worker`

Purpose:

```text
headless implementation worker
```

Usage:

```powershell
glm-worker "Implement validation and add tests"
```

và bắt buộc support stdin:

```powershell
@"
TASK:
Implement refresh token validation.

SCOPE:
internal/auth/

VALIDATION:
go test ./internal/auth/...
"@ | glm-worker
```

Đây là cải tiến so với `.cmd` cũ.

Input priority:

```text
stdin
  ↓ if available

arguments
  ↓

error if empty
```

---

# 16. glm-worker Claude invocation

Equivalent command:

```text
claude.exe
    -p <prompt>
    --max-turns 20
    --permission-mode acceptEdits
    --tools Read,Glob,Grep,Edit,Write,Bash
```

Claude Code hiện hỗ trợ `-p`, `--max-turns`, `--permission-mode`, `--tools` và `--allowedTools`. `--tools` giới hạn tool surface; `--allowedTools` chủ yếu pre-approves tools và không phải cơ chế giới hạn tool duy nhất.

V0.1 dùng:

```text
--tools
```

để giới hạn worker.

Không sử dụng:

```text
--dangerously-skip-permissions
```

mặc định.

---

# 17. `glm-review`

Read-only worker.

Usage:

```powershell
glm-review "Analyze auth module"
```

Equivalent:

```text
claude.exe
    -p <prompt>
    --max-turns 15
    --tools Read,Glob,Grep
```

Không expose:

```text
Edit
Write
Bash
```

cho worker này.

Use cases:

```text
repository exploration
call graph discovery
duplicate detection
dependency inspection
preliminary code review
implementation discovery
```

---

# 18. Process handling

Tất cả worker process phải:

```text
inherit cwd
inherit stdout/stderr
forward SIGINT / Ctrl+C
propagate exit code
```

Example:

```ts
child.on("exit", code => {
  process.exit(code ?? 1);
});
```

Nếu:

```text
Ctrl+C
```

thì child Claude phải nhận interrupt.

---

# 19. Claude integration

Tool không overwrite `CLAUDE.md`.

Command:

```powershell
glm-router project init
```

phải detect:

```text
project root
```

ưu tiên:

```text
git rev-parse --show-toplevel
```

Nếu không có Git:

```text
cwd
```

---

# 20. Managed block

Trong `CLAUDE.md`:

```markdown
<!-- glm-coding-router:start -->

## GLM Worker Delegation

GLM workers available:

- `glm-worker "<task>"`
- `glm-review "<task>"`

Delegate well-scoped, implementation-heavy work to GLM.

Use GLM for:
- repository exploration
- CRUD
- boilerplate
- tests
- documentation
- mechanical refactoring
- straightforward implementation

Claude remains responsible for:
- requirements
- architecture
- ambiguous business rules
- security-sensitive decisions
- complex debugging
- integration
- final review

Before delegation, define:
- task
- scope
- allowed files
- forbidden files
- requirements
- constraints
- acceptance criteria
- validation command
- expected output

After worker completion:
1. inspect the actual diff
2. validate against requirements
3. run relevant tests
4. resolve integration problems
5. accept only after verification

<!-- glm-coding-router:end -->
```

---

# 21. Managed block rules

Installer phải idempotent.

Nếu block không tồn tại:

```text
append block
```

Nếu block tồn tại:

```text
replace existing block
```

Không bao giờ append duplicate.

Nếu file không tồn tại:

```text
create file
```

Nếu file tồn tại:

```text
preserve all content outside managed block
```

---

# 22. Atomic file modification

Không write trực tiếp file production.

Flow:

```text
read
 ↓
modify in memory
 ↓
write .tmp
 ↓
fsync / close
 ↓
rename
```

Trước lần sửa đầu tiên có thể tạo:

```text
CLAUDE.md.glm-router.bak
```

nhưng v0.1 có thể bỏ backup nếu atomic update được test tốt.

Ưu tiên hỗ trợ:

```text
--dry-run
```

---

# 23. Codex integration

Codex dùng:

```text
AGENTS.md
```

làm persistent repository instruction.

OpenAI mô tả Codex đọc `AGENTS.md` và `AGENTS.override.md` từ Codex home và từ project root xuống current directory; instruction cụ thể hơn được đưa vào context sau instruction tổng quát hơn.

Command:

```powershell
glm-router project init
```

phải update đồng thời:

```text
CLAUDE.md
AGENTS.md
```

nếu integration tương ứng enabled.

---

# 24. AGENTS.md managed block

```markdown
<!-- glm-coding-router:start -->

## GLM Worker Delegation

Available commands:

- `glm-worker "<task>"`
- `glm-review "<task>"`

Codex is the primary orchestrator.

Delegate:
- CRUD
- boilerplate
- tests
- documentation
- mechanical refactoring
- repository exploration
- straightforward implementation

Keep in Codex:
- requirements
- planning
- architecture
- ambiguous business logic
- complex debugging
- security decisions
- integration
- final review

Before delegation create a task packet:

TASK
SCOPE
FILES ALLOWED TO MODIFY
FILES NOT TO MODIFY
REQUIREMENTS
CONSTRAINTS
ACCEPTANCE CRITERIA
VALIDATION
EXPECTED OUTPUT

Never trust a worker's success report without inspecting the resulting changes.

<!-- glm-coding-router:end -->
```

---

# 25. Codex Skill

Skill là optional enhancement.

Purpose:

```text
teach Codex reusable delegation workflow
```

OpenAI hiện hỗ trợ reusable Skills dựa trên `SKILL.md`, đồng thời Codex có thể consume skills alongside `AGENTS.md`.

Skill name:

```text
glm-delegation
```

---

# 26. SKILL.md specification

```markdown
---
name: glm-delegation
description: >
  Delegate well-scoped implementation, testing,
  repository exploration, boilerplate, CRUD,
  documentation, and mechanical refactoring to
  GLM Coding Plan workers.
---

# GLM Delegation

Available commands:

glm-worker "<task>"
glm-review "<task>"

## Use glm-review for

- repository exploration
- dependency analysis
- locating implementations
- call-chain discovery
- code review

## Use glm-worker for

- CRUD
- unit tests
- implementation
- documentation
- repetitive changes
- mechanical refactoring

## Keep in primary Codex agent

- requirements
- architecture
- ambiguous rules
- security-sensitive design
- difficult debugging
- integration
- final acceptance

## Delegation packet

Always provide:

TASK
SCOPE
ALLOWED FILES
FORBIDDEN FILES
REQUIREMENTS
CONSTRAINTS
ACCEPTANCE CRITERIA
VALIDATION
EXPECTED OUTPUT

## Verification

After GLM finishes:

- inspect the actual diff
- independently run relevant validation
- compare implementation with requirements
- reject or correct worker output when needed
```

---

# 27. Skill installation strategy

Do not tightly couple the whole application to one Codex skill-directory assumption.

Create abstraction:

```ts
interface SkillInstaller {
  detect(): Promise<SkillLocation | null>;
  install(skill: SkillDefinition): Promise<void>;
  remove(name: string): Promise<void>;
}
```

If current Codex installation exposes supported local skill location:

```text
install automatically
```

otherwise:

```text
warn user
skip optional skill
keep AGENTS.md integration
```

The core tool must continue working without the Skill.

---

# 28. Configuration commands

```powershell
glm-router config show
```

Output:

```text
Provider: Z.ai
Main model: glm-5.3
Fast model: glm-5.3-flash

Worker:
  max turns: 20

Review:
  max turns: 15

Integrations:
  Claude: enabled
  Codex: enabled
  Codex skill: enabled
```

Change:

```powershell
glm-router config set models.main glm-5.3
glm-router config set models.fast glm-5.3-flash
```

---

# 29. Config validation

Use schema validation library such as:

```text
zod
```

Schema example:

```ts
const ConfigSchema = z.object({
  schemaVersion: z.literal(1),

  provider: z.object({
    name: z.literal("zai"),
    anthropicBaseUrl: z.string().url()
  }),

  models: z.object({
    main: z.string().min(1),
    fast: z.string().min(1)
  }),

  worker: z.object({
    maxTurns: z.number().int().positive()
  }),

  review: z.object({
    maxTurns: z.number().int().positive()
  })
});
```

---

# 30. Project structure

```text
glm-coding-router/
│
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
│
├── src/
│   ├── cli.ts
│   │
│   ├── bin/
│   │   ├── glm-chat.ts
│   │   ├── glm-worker.ts
│   │   └── glm-review.ts
│   │
│   ├── commands/
│   │   ├── init.ts
│   │   ├── doctor.ts
│   │   ├── status.ts
│   │   ├── uninstall.ts
│   │   ├── config.ts
│   │   ├── key.ts
│   │   ├── project-init.ts
│   │   └── project-remove.ts
│   │
│   ├── core/
│   │   ├── config.ts
│   │   ├── paths.ts
│   │   ├── zai-key.ts
│   │   ├── claude.ts
│   │   ├── process.ts
│   │   └── platform.ts
│   │
│   ├── integrations/
│   │   ├── claude.ts
│   │   ├── codex.ts
│   │   └── skill.ts
│   │
│   ├── project/
│   │   ├── managed-block.ts
│   │   ├── project-root.ts
│   │   └── atomic-write.ts
│   │
│   └── templates/
│       ├── claude-block.ts
│       ├── agents-block.ts
│       └── glm-delegation-skill.ts
│
└── tests/
    ├── unit/
    ├── integration/
    └── fixtures/
```

---

# 31. package.json

Suggested:

```json
{
  "name": "glm-coding-router",
  "version": "0.1.0",
  "description": "GLM Coding Plan workers for Claude Code and Codex",
  "type": "module",

  "bin": {
    "glm-router": "./dist/cli.js",
    "glm-chat": "./dist/bin/glm-chat.js",
    "glm-worker": "./dist/bin/glm-worker.js",
    "glm-review": "./dist/bin/glm-review.js"
  },

  "files": [
    "dist"
  ],

  "scripts": {
    "dev": "tsx src/cli.ts",
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src tests",
    "prepublishOnly": "npm run build && npm test"
  },

  "engines": {
    "node": ">=20"
  },

  "dependencies": {
    "commander": "^14",
    "prompts": "^2",
    "zod": "^4"
  },

  "devDependencies": {
    "@types/node": "^24",
    "@types/prompts": "^2",
    "typescript": "^5",
    "tsx": "^4",
    "vitest": "^3",
    "eslint": "^9"
  }
}
```

Version numbers should be checked at implementation time.

---

# 32. Process spawning abstraction

Create:

```ts
interface SpawnAgentOptions {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
}
```

Function:

```ts
spawnClaude(options)
```

Responsibilities:

```text
locate claude.exe
inject env
spawn child
inherit cwd
pipe/inherit stdio
forward signals
return exit code
```

---

# 33. Claude binary discovery

Order:

```text
1. `where.exe claude`
2. PATH search through Node
3. config override
4. error
```

Do not assume:

```text
claude.cmd
```

because current standalone installs may expose:

```text
claude.exe
```

as already observed.

---

# 34. Codex discovery

Similar:

```text
where.exe codex
```

`doctor` should report Codex absence as:

```text
WARN
```

not fatal.

Tool must work with Claude-only setup.

Likewise Claude absence is fatal only when running GLM commands because the initial GLM harness implementation relies on Claude Code.

---

# 35. Error handling

Standard error codes:

```text
0   success

1   generic failure

2   invalid arguments

10  ZAI key missing

11  configuration invalid

20  claude executable missing

21  codex executable missing

30  project root not found

31  managed file write failed

40  child agent failed

50  unsupported platform
```

---

# 36. Error messages

Example:

```text
ERROR [ZAI_KEY_MISSING]

ZAI_API_KEY was not found.

Run:

  glm-router key set
```

Another:

```text
ERROR [CLAUDE_NOT_FOUND]

Claude Code executable was not found in PATH.

Expected:

  claude.exe
```

Messages phải actionable.

---

# 37. Logging

Levels:

```text
error
warn
info
debug
```

Default:

```text
info
```

Verbose:

```powershell
glm-router doctor --verbose
```

Debug output phải redact:

```text
ZAI_API_KEY
ANTHROPIC_AUTH_TOKEN
Authorization headers
```

Redaction format:

```text
sk-abc...xyz
```

hoặc tốt hơn:

```text
[REDACTED]
```

---

# 38. Security requirements

Mandatory:

1. Never commit API key.
2. Never store key in project.
3. Never print complete key.
4. Never send telemetry in v0.1.
5. Never modify Claude global auth.
6. Never modify Codex auth.
7. Never persist `ANTHROPIC_BASE_URL` globally.
8. Inject provider env only into GLM child process.
9. Use safe child-process APIs.
10. Avoid `shell: true` unless absolutely necessary.
11. Escape Windows arguments correctly.
12. Do not construct PowerShell commands from unescaped arbitrary user data.

---

# 39. Prompt handling

Avoid:

```ts
exec(`claude -p "${prompt}"`)
```

because prompt can contain:

```text
quotes
ampersands
pipes
newlines
special characters
```

Use:

```ts
spawn(claudePath, args)
```

with argument array.

Support stdin natively.

---

# 40. Stdin handling

Utility:

```ts
async function readStdin(): Promise<string | undefined>
```

Only read stdin when:

```text
process.stdin.isTTY === false
```

Input selection:

```text
if stdin contains text
    use stdin
else if args contain prompt
    join args
else
    throw PromptRequired
```

This allows:

```powershell
glm-worker "Fix login"
```

and:

```powershell
Get-Content task.md | glm-worker
```

---

# 41. Status command

```powershell
glm-router status
```

Must be quick and offline.

Output:

```text
GLM Coding Router v0.1.0

Z.ai key        configured
Claude          installed
Codex           installed

Claude policy   enabled
Codex policy    enabled
Codex skill     enabled

Main model      glm-5.3
Fast model      glm-5.3-flash
```

No API request required.

---

# 42. Optional provider connectivity check

Doctor may optionally run:

```powershell
glm-router doctor --network
```

Network tests should:

```text
verify endpoint reachable
```

without running expensive coding tasks where possible.

Do not automatically consume meaningful quota during ordinary `doctor`.

---

# 43. Project remove

```powershell
glm-router project remove
```

Only remove:

```text
<!-- glm-coding-router:start -->
...
<!-- glm-coding-router:end -->
```

Preserve all user content.

If resulting file becomes empty:

```text
optionally delete
```

only if the file was originally created entirely by router.

Track ownership metadata locally where possible.

---

# 44. Uninstall

```powershell
glm-router uninstall
```

Wizard:

```text
Remove global configuration? Yes
Remove Codex skill? Yes
Remove current project integration? No
Remove ZAI_API_KEY? No
```

Default:

```text
keep ZAI_API_KEY
```

because destructive credential removal should require explicit consent.

---

# 45. `--dry-run`

Commands modifying files should support:

```powershell
glm-router project init --dry-run
```

Output diff:

```diff
+ <!-- glm-coding-router:start -->
+ ...
+ <!-- glm-coding-router:end -->
```

without write.

---

# 46. Idempotency requirements

These commands must safely run repeatedly:

```text
glm-router init
glm-router project init
glm-router skill install
```

Second run must result in:

```text
already configured
```

or update existing managed state.

Never create duplicates.

---

# 47. Testing strategy

## Unit tests

Cover:

```text
config parsing
key resolution
managed block insertion
managed block update
managed block removal
project root detection
prompt argument parsing
stdin priority
environment construction
secret redaction
```

## Integration tests

Use fake executables:

```text
fake-claude.exe
fake-codex.exe
```

to verify arguments/environment without spending API quota.

---

# 48. Managed block test cases

Mandatory cases:

```text
empty file

existing CLAUDE.md

existing AGENTS.md

managed block already exists

corrupt start marker

corrupt end marker

CRLF

LF

UTF-8

file without trailing newline
```

On malformed marker pair:

```text
do not modify file
return actionable error
```

---

# 49. Windows test matrix

Minimum:

```text
Windows 10
Windows 11

PowerShell 5.1
PowerShell 7.x

Node 20
Node current LTS

normal terminal
Windows Terminal
Orca embedded terminal
```

---

# 50. Acceptance criteria v0.1

Release is considered complete when a fresh Windows machine can perform:

```powershell
npm install -g glm-coding-router

glm-router init
```

and then:

```powershell
glm-chat
```

successfully starts an interactive GLM-backed Claude Code session.

Then:

```powershell
glm-worker "Reply exactly with WORKER_OK"
```

returns:

```text
WORKER_OK
```

Then:

```powershell
glm-review "Inspect this repository"
```

cannot edit files.

Then:

```powershell
glm-router project init
```

correctly creates/updates:

```text
CLAUDE.md
AGENTS.md
```

without destroying existing content.

Finally:

```powershell
claude
```

must still use normal Claude authentication, and:

```powershell
codex
```

must still use normal Codex authentication.

---

# 51. Definition of Done

v0.1 is done when:

```text
✓ package installs globally
✓ four CLI binaries work
✓ ZAI key setup works
✓ stale Orca environment handled
✓ Claude detection works
✓ Codex detection works
✓ interactive GLM works
✓ worker GLM works
✓ read-only GLM works
✓ stdin works
✓ project init idempotent
✓ project remove safe
✓ doctor works
✓ status works
✓ uninstall works
✓ secrets never logged
✓ unit tests pass
✓ integration tests pass
✓ README complete
```

---

# 52. README requirements

README should contain:

```text
What it is

Architecture

Requirements

Installation

Quick start

glm-chat

glm-worker

glm-review

Claude integration

Codex integration

Orca behavior

Security model

Troubleshooting

Uninstall

Development

Publishing
```

---

# 53. Suggested development phases

## Phase 1 — Runtime core

Implement:

```text
binary detection
key resolution
env injection
glm-chat
glm-worker
glm-review
```

Exit criteria:

```text
all three GLM commands work
```

---

## Phase 2 — Installer CLI

Implement:

```text
init
status
doctor
key set
config
```

---

## Phase 3 — Project integrations

Implement:

```text
project root
CLAUDE.md
AGENTS.md
managed blocks
dry-run
project remove
```

---

## Phase 4 — Codex Skill

Implement:

```text
skill detection
skill install
skill remove
SKILL.md
```

---

## Phase 5 — Hardening

Implement:

```text
secret redaction
atomic write
error codes
Windows test matrix
Orca tests
uninstall
```

---

# 54. Future roadmap

## v0.2

```text
Linux
macOS
glm-fast command
worker profiles
custom model profiles
```

Example:

```powershell
glm-worker --profile test
glm-worker --profile frontend
glm-worker --profile backend
```

---

## v0.3

Git worktree orchestration:

```text
glm-router delegate backend
glm-router delegate frontend
glm-router delegate tests
```

Each worker runs in isolated worktree.

---

## v0.4

Benchmarking:

```text
glm-router benchmark
```

Compare:

```text
Claude + GLM
Codex + GLM
```

Metrics:

```text
duration
GLM calls
retry count
tests
success
manual intervention
```

---

## v0.5

Usage integration:

```text
GLM credit consumption
Claude quota snapshots
Codex usage snapshots
```

where provider APIs allow reliable retrieval.

---

## v1.0

Potential architecture:

```text
CLI
+
Agent Skill
+
optional MCP
+
plugin packaging
```

OpenAI currently supports reusable Skills as a general workflow abstraction, and its current Codex architecture incorporates skills alongside repository instructions such as `AGENTS.md`.

---

# 55. Final architecture decision

The implementation should intentionally separate two responsibilities:

```text
GLM Coding Router CLI
        │
        ├── machine configuration
        ├── credentials
        ├── agent launching
        ├── diagnostics
        └── project integration

Agent instructions / Skill
        │
        ├── delegation policy
        ├── task routing
        ├── task packet
        └── verification workflow
```

Do not attempt to solve machine setup entirely with a Skill.

Do not attempt to encode agent workflow entirely inside installer logic.

The two layers should remain independent.

---

# 56. Recommended implementation order

Start coding in this exact order:

```text
1. package skeleton
2. locateClaude()
3. resolveZaiApiKey()
4. createGlmEnv()
5. glm-chat
6. prompt parser
7. glm-worker
8. glm-review
9. config system
10. doctor
11. status
12. managed-block engine
13. CLAUDE.md integration
14. AGENTS.md integration
15. project init/remove
16. Codex skill
17. uninstall
18. tests
19. README
20. npm publish
```

Không bắt đầu từ wizard hoặc Skill trước.

Core runtime phải hoạt động trước.