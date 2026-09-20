/**
 * Arguments shared by every headless agent we spawn
 * (specs/review-mcp-isolation.md).
 */

/**
 * Keep the user's MCP servers out of the children we construct.
 *
 * `--tools` only restricts Claude Code's **built-in** set, so MCP tools
 * registered at user/project scope are additive and survive it. With our own
 * server registered (`glm-router mcp install`), that handed every `glm-review`
 * session an `mcp__glm-coding-router__glm_worker` — write access and recursion
 * from a surface documented as read-only.
 *
 * `--strict-mcp-config` uses only the servers given by `--mcp-config`. We pass
 * none, so the set is empty and the child's tool surface is exactly the one we
 * asked for. Security setting: not configurable, not overridable by a profile.
 * Interactive sessions (`glm-chat`, `glm-fast`) are deliberately excluded —
 * the user's own servers are theirs.
 */
export const STRICT_MCP_ARGS: readonly string[] = ["--strict-mcp-config"];
