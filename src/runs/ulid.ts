import { randomBytes } from "node:crypto";

/**
 * ULID generation (specs/v2-architecture.md, Phase B).
 *
 * Lexicographic sort order equals chronological order — that property, not
 * the id's shape, is why runs use ULIDs instead of UUIDs: the run history is
 * browsed by sorting ids as plain strings.
 */

/** Crockford base32: no I, L, O or U, so no visually ambiguous character ever appears in a run id. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const TIME_LEN = 10;
const RANDOM_BYTES = 10; // 80 bits = exactly 16 base32 chars × 5 bits

/**
 * Process-wide monotonic state: the last timestamp used and the random
 * component it was paired with. Two ids in the same millisecond must still
 * order, so the second one increments the first one's randomness instead of
 * drawing fresh bytes.
 */
let lastTime = -1;
let lastRandom: Uint8Array | null = null;

/**
 * A 26-char ULID: 10 chars of millisecond timestamp (most significant first)
 * followed by 16 chars of randomness. Monotonic within the process — same-ms
 * calls increment the 80-bit random component as a big-endian integer, so
 * generated ids never collide and always sort after their predecessors.
 * `now` is injectable so tests can pin and freeze time.
 */
export function ulid(now: () => number = Date.now): string {
  let time = now();
  let random: Uint8Array | null = null;

  // `<=` rather than `===` also absorbs a clock that jumps backwards: reusing
  // the last timestamp with an incremented random part preserves the invariant
  // that actually matters — generation order == sort order.
  if (lastRandom !== null && time <= lastTime) {
    random = incrementRandom(lastRandom);
    if (random === null) {
      // All 80 random bits overflowed (probability 2^-80). Spin to the next
      // millisecond rather than return a value that sorts before its
      // predecessor; if the clock never advances (a frozen injected clock),
      // step the timestamp ourselves — still strictly after the previous id.
      let spins = 0;
      do {
        time = now();
      } while (time <= lastTime && ++spins < 1_000_000);
      if (time <= lastTime) {
        time = lastTime + 1;
      }
      random = randomBytes(RANDOM_BYTES);
    } else {
      time = lastTime;
    }
  } else {
    random = randomBytes(RANDOM_BYTES);
  }

  lastTime = time;
  lastRandom = random;
  return encodeTime(time) + encodeRandom(random);
}

/** `run_` + a ULID (doc §5): the prefix makes run ids self-describing in logs, dirs and file names. */
export function runId(now: () => number = Date.now): string {
  return `run_${ulid(now)}`;
}

/**
 * A 48-bit millisecond timestamp fits exactly in a double, so plain division
 * encodes it most-significant-first into 10 chars — which is what makes the
 * time part of the string sort chronologically.
 */
function encodeTime(time: number): string {
  let chars = "";
  let remaining = time;
  for (let count = 0; count < TIME_LEN; count++) {
    chars = ENCODING[remaining % 32] + chars;
    remaining = Math.floor(remaining / 32);
  }
  return chars;
}

/**
 * 10 bytes → 16 × 5-bit symbols, big-endian. 80 is a multiple of 5, so the
 * bit funnel drains exactly with nothing left over.
 */
function encodeRandom(bytes: Uint8Array): string {
  let chars = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars += ENCODING[(buffer >>> bits) & 31];
    }
  }
  return chars;
}

/**
 * +1 on the 80-bit random component read as a big-endian integer. Returns
 * null when every bit was already 1 — the caller must then move to a new
 * millisecond, because a wrapped value would sort before its predecessor.
 */
function incrementRandom(bytes: Uint8Array): Uint8Array | null {
  const next = Uint8Array.from(bytes);
  for (let index = next.length - 1; index >= 0; index--) {
    if (next[index] < 0xff) {
      next[index] += 1;
      return next;
    }
    next[index] = 0;
  }
  return null;
}
