import { describe, expect, it } from "vitest";
import { inspectZaiKey } from "../../src/core/key-inspector.js";

function diag(readable: boolean, value: string | undefined): (name: string) => { readable: boolean; value: string | undefined } {
  return () => ({ readable, value });
}

describe("inspectZaiKey (specs/terminal-ui-doctor.md §C)", () => {
  it("both sources equal → match, keyMismatch false", () => {
    const result = inspectZaiKey({ env: { ZAI_API_KEY: "same" }, readUserEnvDiagnostic: diag(true, "same"), store: "windows-user-env" });
    expect(result.comparison).toBe("match");
    expect(result.keyMismatch).toBe(false);
    expect(result.effectiveKey).toBe("same");
    expect(result.effectiveSource).toBe("process-env");
  });

  it("both sources differ → different, keyMismatch true, process wins", () => {
    const result = inspectZaiKey({
      env: { ZAI_API_KEY: "process-value" },
      readUserEnvDiagnostic: diag(true, "stored-value"),
      store: "windows-user-env",
    });
    expect(result.comparison).toBe("different");
    expect(result.keyMismatch).toBe(true);
    expect(result.effectiveKey).toBe("process-value");
    expect(result.effectiveSource).toBe("process-env");
  });

  it("whitespace-only process value is treated as absent, falls back to the store", () => {
    const result = inspectZaiKey({
      env: { ZAI_API_KEY: "   " },
      readUserEnvDiagnostic: diag(true, "stored-value"),
      store: "windows-user-env",
    });
    expect(result.effectiveKey).toBe("stored-value");
    expect(result.effectiveSource).toBe("user-store");
    expect(result.comparison).toBe("not-comparable");
    expect(result.keyMismatch).toBeNull();
  });

  it("only the process value is set (store empty) → not-comparable", () => {
    const result = inspectZaiKey({
      env: { ZAI_API_KEY: "process-only" },
      readUserEnvDiagnostic: diag(true, undefined),
      store: "windows-user-env",
    });
    expect(result.comparison).toBe("not-comparable");
    expect(result.keyMismatch).toBeNull();
    expect(result.effectiveSource).toBe("process-env");
  });

  it("only the store value is set → not-comparable, effective source is the store", () => {
    const result = inspectZaiKey({
      env: {},
      readUserEnvDiagnostic: diag(true, "stored-only"),
      store: "windows-user-env",
    });
    expect(result.comparison).toBe("not-comparable");
    expect(result.effectiveKey).toBe("stored-only");
    expect(result.effectiveSource).toBe("user-store");
  });

  it("both missing → not-comparable, no effective key", () => {
    const result = inspectZaiKey({ env: {}, readUserEnvDiagnostic: diag(true, undefined), store: "none" });
    expect(result.comparison).toBe("not-comparable");
    expect(result.effectiveKey).toBeUndefined();
    expect(result.effectiveSource).toBeUndefined();
  });

  it("store read failure with a process key present → unavailable, not equality/absence", () => {
    const result = inspectZaiKey({
      env: { ZAI_API_KEY: "process-value" },
      readUserEnvDiagnostic: diag(false, undefined),
      store: "windows-user-env",
    });
    expect(result.comparison).toBe("unavailable");
    expect(result.keyMismatch).toBeNull();
    expect(result.effectiveKey).toBe("process-value");
  });

  it("never changes precedence: process always wins when both are present, regardless of comparison outcome", () => {
    const match = inspectZaiKey({ env: { ZAI_API_KEY: "x" }, readUserEnvDiagnostic: diag(true, "x"), store: "windows-user-env" });
    const diff = inspectZaiKey({ env: { ZAI_API_KEY: "x" }, readUserEnvDiagnostic: diag(true, "y"), store: "windows-user-env" });
    expect(match.effectiveSource).toBe("process-env");
    expect(diff.effectiveSource).toBe("process-env");
  });
});
