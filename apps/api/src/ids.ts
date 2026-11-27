import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * A new random ID such as `ws_k3x…`: a prefix plus 20 lowercase base32
 * characters (100 bits). Matches the `<prefix>_[a-z0-9_]+` shape the event
 * contract expects for workspace IDs.
 */
export function newId(prefix: "ws" | "usr" | "tok" | "repo"): string {
  const bytes = randomBytes(20);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return `${prefix}_${out}`;
}

/** True when `value` has the shape of an ID with this prefix (cheap pre-check before a lookup). */
export function looksLikeId(prefix: string, value: string): boolean {
  return new RegExp(`^${prefix}_[a-z0-9_]{1,64}$`).test(value);
}
