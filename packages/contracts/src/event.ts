import { z } from "zod";

/**
 * Contract for a normalized event: the shape every source (signed GitHub
 * webhook or local replay) is converted into before it reaches a timeline.
 * Facts only — correlations and hypotheses live in other records.
 */

const commitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a full 40-character lowercase commit SHA");

const timestamp = z.string().datetime({ offset: false, message: "must be an ISO-8601 UTC timestamp" });

const slug = z.string().regex(/^[A-Za-z0-9_.-]+$/, "must contain only letters, digits, '.', '_' or '-'");

export const EVENT_SOURCES = ["github", "replay"] as const;
export const EventSourceSchema = z.enum(EVENT_SOURCES);

export const RepositoryRefSchema = z.object({
  owner: slug,
  name: slug,
});

export const ProvenanceSchema = z.object({
  /** Delivery the event was normalized from (webhook delivery ID or replay row). */
  deliveryId: z.string().min(1),
  receivedAt: timestamp,
  /** Set only for replayed fixtures, so synthetic data is never mistaken for real data. */
  fixture: z.string().min(1).optional(),
});

const base = {
  /** Stable SignalTrail ID; also the evidence ID that reports cite. */
  id: z.string().regex(/^evt_[a-z0-9_]+$/, "must look like evt_<lowercase id>"),
  workspaceId: z.string().regex(/^ws_[a-z0-9_]+$/, "must look like ws_<lowercase id>"),
  source: EventSourceSchema,
  /** ID of the object in the source system (PR number, check run ID, …). */
  sourceId: z.string().min(1),
  occurredAt: timestamp,
  repository: RepositoryRefSchema,
  provenance: ProvenanceSchema,
};

export const PullRequestMergedSchema = z.object({
  ...base,
  kind: z.literal("pull_request.merged"),
  commitSha,
  data: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    author: z.string().min(1),
    baseBranch: z.string().min(1),
  }),
});

export const CheckRunCompletedSchema = z.object({
  ...base,
  kind: z.literal("check_run.completed"),
  commitSha,
  data: z.object({
    name: z.string().min(1),
    conclusion: z.enum(["success", "failure", "cancelled", "skipped", "timed_out", "neutral"]),
    url: z.string().url().optional(),
  }),
});

export const DeploymentStatusSchema = z.object({
  ...base,
  kind: z.literal("deployment.status"),
  commitSha,
  data: z.object({
    deploymentId: z.string().min(1),
    environment: z.string().min(1),
    state: z.enum(["queued", "in_progress", "success", "failure", "error", "inactive"]),
  }),
});

export const AlertTriggeredSchema = z.object({
  ...base,
  kind: z.literal("alert.triggered"),
  /** Alerts are not tied to a commit; correlating them is a separate, explicit step. */
  commitSha: z.null(),
  data: z.object({
    service: z.string().min(1),
    summary: z.string().min(1),
    severity: z.enum(["critical", "high", "medium", "low"]),
  }),
});

export const NormalizedEventSchema = z.discriminatedUnion("kind", [
  PullRequestMergedSchema,
  CheckRunCompletedSchema,
  DeploymentStatusSchema,
  AlertTriggeredSchema,
]);

/** Every event kind, in a fixed order (for filters and database checks). */
export const EVENT_KINDS = NormalizedEventSchema.options.map((schema) => schema.shape.kind.value) as [
  EventKind,
  ...EventKind[],
];

export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;
export type EventKind = NormalizedEvent["kind"];

/**
 * Stable timeline order: occurredAt, then source, then sourceId, then id.
 * Events with the same timestamp never swap places between reads.
 */
export function compareEvents(a: NormalizedEvent, b: NormalizedEvent): number {
  return (
    cmp(Date.parse(a.occurredAt), Date.parse(b.occurredAt)) ||
    cmp(a.source, b.source) ||
    cmp(a.sourceId, b.sourceId) ||
    cmp(a.id, b.id)
  );
}

function cmp<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
