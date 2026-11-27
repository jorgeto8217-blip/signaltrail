import { EVENT_KINDS, NormalizedEventSchema, type NormalizedEvent } from "@signaltrail/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMembership } from "../auth/guard.js";
import { canonicalEvent, decodeCursor, encodeCursor, eventFingerprint } from "../events/canonical.js";
import { eventNotFound, invalidCursor, invalidEvents, invalidRequest } from "../errors.js";
import { looksLikeId } from "../ids.js";
import type { EventRecord, InsertEventResult, RepositoryRecord, Store } from "../store/types.js";
import { parseBody } from "./validation.js";

export const MAX_EVENTS_PER_REQUEST = 500;
const MAX_ID_LENGTH = 64; // after the "evt_" prefix
const MAX_SOURCE_ID_LENGTH = 200;

const StoreEventsBody = z
  .object({ events: z.array(NormalizedEventSchema).min(1).max(MAX_EVENTS_PER_REQUEST) })
  .strict();

const ListEventsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(512).optional(),
    kind: z.enum(EVENT_KINDS).optional(),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-character lowercase commit SHA").optional(),
    repositoryId: z.string().regex(/^repo_[a-z0-9_]{1,64}$/, "must be a repository ID").optional(),
  })
  .strict();

type WsParams = { workspaceId: string };
type EventParams = WsParams & { eventId: string };

const eventView = (r: EventRecord) => ({ ...r.event, repositoryId: r.repositoryId, recordedAt: r.recordedAt.toISOString() });

interface Issue {
  path: string;
  message: string;
}

/**
 * Rules the contract alone does not enforce for events submitted over HTTP:
 * they belong to this workspace, come from a connected repository, and are
 * replayed fixtures (GitHub events only arrive through signed webhooks).
 */
async function checkEvents(store: Store, workspaceId: string, events: NormalizedEvent[]) {
  const issues: Issue[] = [];
  const repositories = new Map<string, RepositoryRecord | null>();
  const repositoryIds: string[] = [];

  for (const [i, event] of events.entries()) {
    const path = `events.${i}`;
    if (event.workspaceId !== workspaceId) {
      issues.push({ path: `${path}.workspaceId`, message: `must be ${workspaceId}, the workspace in the URL` });
    }
    if (event.source !== "replay") {
      issues.push({
        path: `${path}.source`,
        message: 'must be "replay"; GitHub events are accepted only through signed webhooks',
      });
    } else if (event.provenance.fixture === undefined) {
      issues.push({ path: `${path}.provenance.fixture`, message: "is required so replayed data is marked synthetic" });
    }
    if (event.id.length - "evt_".length > MAX_ID_LENGTH) {
      issues.push({ path: `${path}.id`, message: `must be at most ${MAX_ID_LENGTH} characters after "evt_"` });
    }
    if (event.sourceId.length > MAX_SOURCE_ID_LENGTH) {
      issues.push({ path: `${path}.sourceId`, message: `must be at most ${MAX_SOURCE_ID_LENGTH} characters` });
    }

    const { owner, name } = event.repository;
    const key = `${owner}/${name}`.toLowerCase();
    if (!repositories.has(key)) repositories.set(key, await store.findRepositoryByName(workspaceId, owner, name));
    const repository = repositories.get(key);
    if (repository == null) {
      issues.push({ path: `${path}.repository`, message: `${owner}/${name} is not connected to this workspace` });
    }
    repositoryIds.push(repository?.id ?? "");
  }

  if (issues.length > 0) throw invalidEvents(issues);
  return repositoryIds;
}

export function registerEventRoutes(app: FastifyInstance, store: Store): void {
  app.post<{ Params: WsParams }>(
    "/v1/workspaces/:workspaceId/events",
    { bodyLimit: 1024 * 1024 },
    async (request) => {
      const { workspaceId } = request.params;
      await requireMembership(request, store, workspaceId, "maintainer");
      const events = parseBody(StoreEventsBody, request.body).events.map(canonicalEvent);
      const repositoryIds = await checkEvents(store, workspaceId, events);

      // One event at a time, in request order: each insert is atomic on its
      // own, and a retried request yields "duplicate" for what was stored.
      const results: ({ id: string } & InsertEventResult)[] = [];
      for (const [i, event] of events.entries()) {
        const result = await store.insertEvent({
          event,
          repositoryId: repositoryIds[i]!,
          fingerprint: eventFingerprint(event),
        });
        results.push({ id: event.id, ...result });
      }

      const count = (outcome: InsertEventResult["outcome"]) => results.filter((r) => r.outcome === outcome).length;
      return {
        data: { created: count("created"), duplicate: count("duplicate"), conflict: count("conflict"), results },
      };
    },
  );

  app.get<{ Params: WsParams }>("/v1/workspaces/:workspaceId/events", async (request) => {
    const { workspaceId } = request.params;
    await requireMembership(request, store, workspaceId, "viewer");
    const parsed = ListEventsQuery.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw invalidRequest(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    const { cursor, limit, ...filters } = parsed.data;
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    if (after === null) throw invalidCursor();

    const page = await store.listEvents(workspaceId, {
      ...filters,
      ...(after === undefined ? {} : { after }),
      limit: limit + 1,
    });
    const items = page.slice(0, limit);
    const last = items.at(-1);
    return {
      data: items.map(eventView),
      nextCursor: page.length > limit && last !== undefined ? encodeCursor(last.event) : null,
    };
  });

  app.get<{ Params: EventParams }>("/v1/workspaces/:workspaceId/events/:eventId", async (request) => {
    const { workspaceId, eventId } = request.params;
    await requireMembership(request, store, workspaceId, "viewer");
    const record = looksLikeId("evt", eventId) ? await store.findEvent(workspaceId, eventId) : null;
    if (record === null) throw eventNotFound();
    return { data: eventView(record) };
  });
}
