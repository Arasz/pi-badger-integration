/**
 * The per-run global id (PKG-3, D3/D4): a UUID v7 minted locally from the millisecond clock
 * plus `randomBytes` — 48-bit big-endian timestamp, version nibble 7, RFC 4122 variant — so
 * the scheme does not depend on the running Node version's `randomUUIDv7` (F6) and the ids
 * sort chronologically by their timestamp prefix.
 */

import { randomBytes } from "node:crypto";

/** The exact shape `newGlobalId` produces: lowercase v7 UUID, variant 10xx. */
export const GLOBAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Mint one global id for a run started at `now` (ms). Injectable clock for deterministic tests. */
export function newGlobalId(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = Math.max(0, Math.floor(now));
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether `value` is a global id this extension minted (or could have). */
export function isGlobalId(value: string): boolean {
  return GLOBAL_ID_PATTERN.test(value);
}
