import { createHash } from "node:crypto";
import type { NormalizedEvent } from "@signaltrail/contracts";

/**
 * The stored form of an event: timestamps rewritten as ISO-8601 with
 * millisecond precision (what PostgreSQL keeps), everything else unchanged.
 * Storing and fingerprinting this form means a redelivery that only differs in
 * timestamp formatting ("…:00Z" vs "…:00.000Z") is still the same event.
 */
export function canonicalEvent(event: NormalizedEvent): NormalizedEvent {
  return {
    ...event,
    occurredAt: new Date(event.occurredAt).toISOString(),
    provenance: { ...event.provenance, receivedAt: new Date(event.provenance.receivedAt).toISOString() },
  };
}

/** SHA-256 over the canonical event serialised with sorted keys. */
export function eventFingerprint(event: NormalizedEvent): string {
  return createHash("sha256").update(stableJson(canonicalEvent(event))).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Position of an event in the stable timeline order, used as a keyset cursor. */
export interface EventCursor {
  occurredAt: string;
  source: string;
  sourceId: string;
  id: string;
}

export function encodeCursor(event: NormalizedEvent): string {
  const position = [event.occurredAt, event.source, event.sourceId, event.id];
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

/** Returns null for anything that is not a cursor this API issued. */
export function decodeCursor(cursor: string): EventCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 4 || !parsed.every((p) => typeof p === "string")) return null;
    const [occurredAt, source, sourceId, id] = parsed as [string, string, string, string];
    if (Number.isNaN(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt) return null;
    return { occurredAt, source, sourceId, id };
  } catch {
    return null;
  }
}
