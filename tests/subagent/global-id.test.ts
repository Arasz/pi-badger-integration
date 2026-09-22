/**
 * PKG-3 (A3.1) — the per-run global id: a UUID v7 minted locally (timestamp + randomBytes),
 * so the scheme does not depend on the Node version's `randomUUIDv7` (F6).
 */

import { describe, expect, test } from "bun:test";
import { GLOBAL_ID_PATTERN, isGlobalId, newGlobalId } from "../../extensions/subagent/global-id.ts";

/** The 48-bit big-endian millisecond timestamp the v7 prefix encodes. */
function timestampOf(id: string): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

describe("A3.1 — global GUID v7", () => {
  test("global id: is a v7 UUID (version and variant nibbles)", () => {
    const id = newGlobalId(1_700_000_000_000);
    expect(id).toMatch(GLOBAL_ID_PATTERN);
    expect(id[14]).toBe("7"); // version nibble
    expect("89ab").toContain(id[19]!); // RFC 4122 variant nibble
    expect(isGlobalId(id)).toBe(true);
    expect(isGlobalId("not-a-guid")).toBe(false);
    // A v4 UUID is a well-formed GUID but not this scheme's id.
    expect(isGlobalId("00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  test("global id: the timestamp prefix orders ids by the injected clock", () => {
    const early = newGlobalId(1_700_000_000_000);
    const late = newGlobalId(1_700_000_000_001);
    expect(timestampOf(early)).toBe(1_700_000_000_000);
    expect(timestampOf(late)).toBe(1_700_000_000_001);
    expect(early < late).toBe(true); // lexicographic order == chronological order
  });

  test("global id: two ids in the same millisecond differ", () => {
    expect(newGlobalId(1_700_000_000_000)).not.toBe(newGlobalId(1_700_000_000_000));
  });
});
