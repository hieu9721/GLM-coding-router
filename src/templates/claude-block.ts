/** Managed block content for CLAUDE.md (spec §20). Keep in sync with the spec. */
export const CLAUDE_MANAGED_BLOCK = `<!-- glm-coding-router:start -->

## GLM Worker Delegation

GLM workers available:

- \`glm-worker "<task>"\`
- \`glm-review "<task>"\`

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

Worker exit codes 41 and 42 are NOT crashes:

- stdout carries one JSON object: \`{"status":"handoff_required", ...}\`
- read \`handoff_path\` — a handoff.md with what was done, what remains, files
  changed, and untracked files that are NOT in diff.patch
- continue the task yourself in the SAME worktree, starting from "Remaining"
- do not re-run the worker until quota resets
- 41 means nothing was spawned; 42 means work was done and is preserved

<!-- glm-coding-router:end -->`;
