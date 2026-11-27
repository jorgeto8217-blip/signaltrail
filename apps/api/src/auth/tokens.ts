import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "stk_";

/** A new plain API token. Show it once; store only {@link hashToken}. */
export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function readBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{8,200})$/.exec(header.trim());
  return match?.[1] ?? null;
}
