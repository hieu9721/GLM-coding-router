# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**`AGENTS.md` in this same directory is the single source of truth for this repository** —
project purpose, structure, commands, hard rules, session memory, and how the docs scale beyond
v0.1 all live there. Read it in full before doing anything here. Nothing is repeated below;
add a note here only when something is genuinely specific to Claude Code and doesn't apply to
Codex (there is nothing like that today).

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
