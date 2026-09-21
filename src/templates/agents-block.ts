/** Managed block content for AGENTS.md (spec §24). Keep in sync with the spec. */
export const AGENTS_MANAGED_BLOCK = `<!-- glm-coding-router:start -->

## GLM Worker Delegation

Available commands:

- \`glm-worker "<task>"\`
- \`glm-review "<task>"\`

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

Worker exit codes 41 and 42 are NOT crashes:

- stdout carries one JSON object: \`{"status":"handoff_required", ...}\`
- read \`handoff_path\` — a handoff.md with what was done, what remains, files
  changed, and untracked files that are NOT in diff.patch
- continue the task yourself in the SAME worktree, starting from "Remaining"
- do not re-run the worker until quota resets
- 41 means nothing was spawned; 42 means work was done and is preserved

<!-- glm-coding-router:end -->`;
