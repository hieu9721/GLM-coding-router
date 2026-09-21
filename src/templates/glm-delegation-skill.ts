/** Codex skill definition (spec §26). Keep in sync with the spec. */
export const GLM_DELEGATION_SKILL_NAME = "glm-delegation";

export const GLM_DELEGATION_SKILL_MD = `---
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

## Exit codes 41 and 42 are not crashes

A worker may stop because the GLM quota ran low rather than because it broke.

- stdout carries one JSON object: \`{"status":"handoff_required", ...}\`
- read \`handoff_path\` — a handoff.md with what was done, what remains, files
  changed, and untracked files that are NOT in diff.patch
- continue the task yourself in the SAME worktree, starting from "Remaining"
- do not re-run the worker until quota resets
- 41 means nothing was spawned; 42 means work was done and is preserved
`;
