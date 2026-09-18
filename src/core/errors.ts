/** Standard exit codes (spec §35). */
export const ExitCode = {
  Success: 0,
  GenericFailure: 1,
  InvalidArgs: 2,
  ZaiKeyMissing: 10,
  ConfigInvalid: 11,
  ClaudeNotFound: 20,
  CodexNotFound: 21,
  ProjectRootNotFound: 30,
  ManagedFileWriteFailed: 31,
  ChildAgentFailed: 40,
  UnsupportedPlatform: 50,
} as const;

export interface GlmRouterErrorOptions {
  /** Machine-readable name, e.g. ZAI_KEY_MISSING (spec §36). */
  readonly name: string;
  /** Human-readable explanation. */
  readonly message: string;
  /** Optional actionable follow-up lines, e.g. ["Run:", "  glm-router key set"]. */
  readonly hint?: readonly string[];
  /** Process exit code. */
  readonly exitCode: number;
  /** Never include secret values in here — they would be printed. */
}

/** Base error for all expected failures. Printed as `ERROR [NAME]` (spec §36). */
export class GlmRouterError extends Error {
  public readonly codeName: string;
  public readonly hint: readonly string[];
  public readonly exitCode: number;

  public constructor(options: GlmRouterErrorOptions) {
    super(options.message);
    this.name = `GlmRouterError:${options.name}`;
    this.codeName = options.name;
    this.hint = options.hint ?? [];
    this.exitCode = options.exitCode;
  }
}

export const Errors = {
  zaiKeyMissing: (): GlmRouterError =>
    new GlmRouterError({
      name: "ZAI_KEY_MISSING",
      message: "ZAI_API_KEY was not found.",
      hint: ["Run:", "", "  glm-router key set"],
      exitCode: ExitCode.ZaiKeyMissing,
    }),

  configInvalid: (detail: string): GlmRouterError =>
    new GlmRouterError({
      name: "CONFIG_INVALID",
      message: `Configuration is invalid: ${detail}`,
      hint: [
        "Fix or remove the config file:",
        "",
        "  %USERPROFILE%\\.glm-coding-router\\config.json",
      ],
      exitCode: ExitCode.ConfigInvalid,
    }),

  claudeNotFound: (detail?: string): GlmRouterError =>
    new GlmRouterError({
      name: "CLAUDE_NOT_FOUND",
      message:
        detail ??
        "Claude Code executable was not found in PATH.",
      hint: [
        "Expected:",
        "",
        "  claude.exe",
        "",
        "Install Claude Code or set an override:",
        "",
        "  glm-router config set claudePath C:\\path\\to\\claude.exe",
      ],
      exitCode: ExitCode.ClaudeNotFound,
    }),

  codexNotFound: (): GlmRouterError =>
    new GlmRouterError({
      name: "CODEX_NOT_FOUND",
      message: "Codex executable was not found in PATH.",
      hint: ["Codex is optional; Claude-only setups are supported."],
      exitCode: ExitCode.CodexNotFound,
    }),

  projectRootNotFound: (): GlmRouterError =>
    new GlmRouterError({
      name: "PROJECT_ROOT_NOT_FOUND",
      message: "Could not determine the project root.",
      exitCode: ExitCode.ProjectRootNotFound,
    }),

  managedFileWriteFailed: (file: string, cause: string): GlmRouterError =>
    new GlmRouterError({
      name: "MANAGED_FILE_WRITE_FAILED",
      message: `Failed to update ${file}: ${cause}`,
      hint: ["The file was left unmodified."],
      exitCode: ExitCode.ManagedFileWriteFailed,
    }),

  childAgentFailed: (cause: string): GlmRouterError =>
    new GlmRouterError({
      name: "CHILD_AGENT_FAILED",
      message: `The child agent process failed: ${cause}`,
      exitCode: ExitCode.ChildAgentFailed,
    }),

  unsupportedPlatform: (platform: string): GlmRouterError =>
    new GlmRouterError({
      name: "UNSUPPORTED_PLATFORM",
      message: `This command requires Windows (detected: ${platform}).`,
      hint: ["Linux and macOS support is planned for v0.2."],
      exitCode: ExitCode.UnsupportedPlatform,
    }),

  promptRequired: (command = "glm-worker"): GlmRouterError =>
    new GlmRouterError({
      name: "PROMPT_REQUIRED",
      message: "No task prompt was provided.",
      hint: [
        "Usage:",
        "",
        `  ${command} "Implement validation and add tests"`,
        `  Get-Content task.md | ${command}`,
      ],
      exitCode: ExitCode.InvalidArgs,
    }),

  invalidArgs: (detail: string, hint?: readonly string[]): GlmRouterError =>
    new GlmRouterError({
      name: "INVALID_ARGS",
      message: detail,
      hint: hint && hint.length > 0 ? hint : undefined,
      exitCode: ExitCode.InvalidArgs,
    }),

  gitNotFound: (): GlmRouterError =>
    new GlmRouterError({
      name: "GIT_NOT_FOUND",
      message: "git was not found on PATH.",
      hint: ["delegate needs git for worktree isolation.", "", "Install Git for Windows: https://git-scm.com/download/win"],
      exitCode: ExitCode.ProjectRootNotFound,
    }),

  gitRepoRequired: (cwd: string): GlmRouterError =>
    new GlmRouterError({
      name: "GIT_REPO_REQUIRED",
      message: `Not inside a git repository (cwd: ${cwd}).`,
      hint: ["delegate runs each worker in a git worktree and needs a repo root.", "", "Run it from inside the project's git repository, or create one:", "", "  git init"],
      exitCode: ExitCode.ProjectRootNotFound,
    }),

  worktreeFailed: (operation: string, cause: string, hint?: readonly string[]): GlmRouterError =>
    new GlmRouterError({
      name: "WORKTREE_FAILED",
      message: `git ${operation} failed: ${cause.trim() || "unknown git error"}`,
      hint: hint ?? ["Fix the state git describes above, then re-run the delegate command."],
      exitCode: ExitCode.ManagedFileWriteFailed,
    }),

  invalidDelegateName: (name: string): GlmRouterError =>
    new GlmRouterError({
      name: "INVALID_DELEGATE_NAME",
      message: `"${name}" is not a valid delegate name.`,
      hint: ["Use letters, digits, dots, dashes, underscores; start with a letter or digit.", "", "Examples: backend, auth-refresh, tests.v2"],
      exitCode: ExitCode.InvalidArgs,
    }),

  managedBlockCorrupt: (file: string, cause: string): GlmRouterError =>
    new GlmRouterError({
      name: "MANAGED_BLOCK_CORRUPT",
      message: `Managed block in ${file} is malformed: ${cause}`,
      hint: [
        "Fix or remove the markers manually:",
        "",
        "  <!-- glm-coding-router:start -->",
        "  ...",
        "  <!-- glm-coding-router:end -->",
        "",
        "The file was not modified.",
      ],
      exitCode: ExitCode.ManagedFileWriteFailed,
    }),
};

/** Print a GlmRouterError in the spec §36 format. Never print secret values. */
export function formatGlmError(error: GlmRouterError): string {
  const lines = [`ERROR [${error.codeName}]`, "", error.message];
  if (error.hint.length > 0) {
    lines.push("", ...error.hint);
  }
  return lines.join("\n");
}
