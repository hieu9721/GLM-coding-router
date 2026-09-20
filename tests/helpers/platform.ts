/**
 * Platform-aware test fixtures (specs/cross-platform.md).
 *
 * Discovery looks for `claude.exe` on Windows and `claude` everywhere else, so
 * fixtures that plant fake executables must use the local spelling — otherwise
 * the test asserts Windows behavior on a machine that cannot exhibit it.
 */
export const onWindows = process.platform === "win32";

/** `claude` → `claude.exe` on Windows, `claude` elsewhere. */
export function exeName(base: string): string {
  return onWindows ? `${base}.exe` : base;
}

/** The npm shim spelling; only Windows has a distinct one. */
export function cmdName(base: string): string {
  return onWindows ? `${base}.cmd` : base;
}
