import { describe, expect, it } from "vitest";
import { runId, ulid } from "../../src/runs/ulid.js";

/** Crockford base32 (specs/v2-architecture.md, Phase B) — no I, L, O or U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_26 = new RegExp(`^[${CROCKFORD}]{26}$`);

/** Independent decoder used to check the generator's encoding, char by char. */
function decodeBase32(chars: string): bigint {
  return chars.split("").reduce((acc, char) => acc * 32n + BigInt(CROCKFORD.indexOf(char)), 0n);
}

describe("ulid (specs/v2-architecture.md Phase B)", () => {
  it("is 26 characters from the Crockford alphabet", () => {
    for (let index = 0; index < 100; index++) {
      expect(ulid()).toMatch(CROCKFORD_26);
    }
  });

  it("never contains the excluded letters I, L, O or U", () => {
    expect(ulid()).not.toMatch(/[ILOU]/);
  });

  it("two ulids in the same frozen millisecond: the second sorts strictly after the first", () => {
    const frozen = Date.now();
    const first = ulid(() => frozen);
    const second = ulid(() => frozen);
    expect(second > first).toBe(true);
  });

  it("a later millisecond always sorts after an earlier one", () => {
    const base = Date.now();
    const earlier = ulid(() => base);
    const later = ulid(() => base + 1);
    expect(later > earlier).toBe(true);
  });

  it("1000 ulids are all unique", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 1000; index++) {
      seen.add(ulid());
    }
    expect(seen.size).toBe(1000);
  });

  it("sorting ulids generated over increasing timestamps gives chronological order", () => {
    const base = Date.now();
    const generated: string[] = [];
    // Deliberate repeats of the same millisecond: sorting must still land on
    // generation order, which only same-ms monotonicity guarantees.
    for (let step = 0; step < 50; step++) {
      generated.push(ulid(() => base + Math.floor(step / 2)));
    }
    expect([...generated].sort()).toEqual(generated);
  });

  it("runId is run_ plus a 26-char ulid", () => {
    const id = runId();
    expect(id.startsWith("run_")).toBe(true);
    expect(id).toHaveLength("run_".length + 26);
    expect(id.slice("run_".length)).toMatch(CROCKFORD_26);
  });

  it("encodes the timestamp most-significant-first, so string order is time order", () => {
    // One minute ahead of every other clock in this file (and of any real-clock
    // lastTime the module may carry), so this call takes the fresh-entropy
    // path and the first 10 chars decode to exactly this timestamp.
    const t = Date.now() + 60_000;
    const id = ulid(() => t);
    expect(decodeBase32(id.slice(0, 10))).toBe(BigInt(t));
  });

  it("same-ms successor is the previous randomness + 1, the standard monotonic rule", () => {
    // Two minutes ahead, same reasoning as above; the 80-bit value needs
    // BigInt, it does not fit a Number.
    const t = Date.now() + 120_000;
    const first = ulid(() => t);
    const second = ulid(() => t);
    expect(decodeBase32(second.slice(10))).toBe(decodeBase32(first.slice(10)) + 1n);
  });
});
