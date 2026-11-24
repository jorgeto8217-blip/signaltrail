import { z } from "zod";
import { compareEvents, NormalizedEventSchema, type NormalizedEvent } from "./event.js";

/** A replayable scenario: a named, ordered set of synthetic events for one workspace. */
export const EventFixtureSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(1),
  workspaceId: z.string().min(1),
  events: z.array(NormalizedEventSchema).min(1),
});

export type EventFixture = z.infer<typeof EventFixtureSchema>;

export interface FixtureIssue {
  path: string;
  message: string;
}

export type FixtureResult =
  | { ok: true; fixture: EventFixture }
  | { ok: false; issues: FixtureIssue[] };

/**
 * Validate a fixture beyond its shape: event IDs and (source, sourceId) pairs
 * are unique, every event belongs to the fixture's workspace and is marked as
 * synthetic, and events are listed in stable timeline order.
 */
export function validateFixture(input: unknown): FixtureResult {
  const parsed = EventFixtureSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    };
  }

  const fixture = parsed.data;
  const issues: FixtureIssue[] = [];
  const ids = new Set<string>();
  const sourceKeys = new Set<string>();

  fixture.events.forEach((event, i) => {
    const path = `events.${i}`;
    if (ids.has(event.id)) {
      issues.push({ path: `${path}.id`, message: `duplicate event id ${event.id}` });
    }
    ids.add(event.id);

    const sourceKey = `${event.source}:${event.kind}:${event.sourceId}`;
    if (sourceKeys.has(sourceKey)) {
      issues.push({ path: `${path}.sourceId`, message: `duplicate source event ${sourceKey}` });
    }
    sourceKeys.add(sourceKey);

    if (event.workspaceId !== fixture.workspaceId) {
      issues.push({
        path: `${path}.workspaceId`,
        message: `belongs to ${event.workspaceId}, fixture is for ${fixture.workspaceId}`,
      });
    }
    if (event.provenance.fixture !== fixture.name) {
      issues.push({
        path: `${path}.provenance.fixture`,
        message: `must be "${fixture.name}" so replayed data is marked synthetic`,
      });
    }

    const previous = fixture.events[i - 1];
    if (previous && compareEvents(previous, event) > 0) {
      issues.push({ path, message: `out of timeline order (after ${previous.id})` });
    }
  });

  return issues.length > 0 ? { ok: false, issues } : { ok: true, fixture };
}

/** Events sorted into stable timeline order, without mutating the input. */
export function sortTimeline(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort(compareEvents);
}
