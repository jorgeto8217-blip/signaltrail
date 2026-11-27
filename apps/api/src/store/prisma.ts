import { Prisma, type PrismaClient } from "@prisma/client";
import { NormalizedEventSchema, type NormalizedEvent } from "@signaltrail/contracts";
import type { WorkspaceRole } from "../auth/roles.js";
import {
  compareMembers,
  repositoryKey,
  type DeleteRepositoryResult,
  type EventQuery,
  type EventRecord,
  type InsertEventResult,
  type RemoveMemberResult,
  type RepositoryRecord,
  type RoleChangeResult,
  type Store,
} from "./types.js";

const repositorySelect = {
  id: true,
  workspaceId: true,
  owner: true,
  name: true,
  createdById: true,
  createdAt: true,
} as const;

interface EventRow {
  workspace_id: string;
  id: string;
  repository_id: string;
  source: string;
  source_id: string;
  kind: string;
  occurred_at: Date;
  repository_owner: string;
  repository_name: string;
  commit_sha: string | null;
  data: unknown;
  delivery_id: string;
  received_at: Date;
  fixture: string | null;
  recorded_at: Date;
}

const eventColumns = Prisma.sql`workspace_id, id, repository_id, source, source_id, kind, occurred_at, repository_owner,
  repository_name, commit_sha, data, delivery_id, received_at, fixture, recorded_at`;

/** Timeline order compared bytewise, matching `compareEvents` for any database collation. */
const timelineKey = Prisma.sql`occurred_at, source COLLATE "C", source_id COLLATE "C", id COLLATE "C"`;

function toEventRecord(row: EventRow): EventRecord {
  const event = NormalizedEventSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    source: row.source,
    sourceId: row.source_id,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    repository: { owner: row.repository_owner, name: row.repository_name },
    commitSha: row.commit_sha,
    data: row.data,
    provenance: {
      deliveryId: row.delivery_id,
      receivedAt: row.received_at.toISOString(),
      ...(row.fixture === null ? {} : { fixture: row.fixture }),
    },
  });
  return { event, repositoryId: row.repository_id, recordedAt: row.recorded_at };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

/** PostgreSQL store. Owner-count checks lock the workspace row so concurrent demotions cannot remove every owner. */
export class PrismaStore implements Store {
  constructor(private readonly db: PrismaClient) {}

  async findUserByTokenHash(tokenHash: string) {
    const token = await this.db.apiToken.findFirst({
      where: { tokenHash, revokedAt: null },
      select: { user: { select: { id: true, email: true, displayName: true } } },
    });
    return token?.user ?? null;
  }

  async findUserByEmail(email: string) {
    return this.db.user.findUnique({
      // Emails are stored lower-cased (enforced by a CHECK constraint).
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, displayName: true },
    });
  }

  async createWorkspace(input: { id: string; name: string; ownerId: string }) {
    return this.db.workspace.create({
      data: {
        id: input.id,
        name: input.name,
        memberships: { create: { userId: input.ownerId, role: "owner" } },
      },
      select: { id: true, name: true, createdAt: true },
    });
  }

  async findWorkspace(workspaceId: string) {
    return this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true, createdAt: true },
    });
  }

  async listWorkspacesForUser(userId: string) {
    const rows = await this.db.membership.findMany({
      where: { userId },
      select: { role: true, workspace: { select: { id: true, name: true, createdAt: true } } },
      orderBy: [{ workspace: { createdAt: "asc" } }, { workspaceId: "asc" }],
    });
    return rows.map((row) => ({ ...row.workspace, role: row.role }));
  }

  async findMembership(workspaceId: string, userId: string) {
    return this.db.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { workspaceId: true, userId: true, role: true, createdAt: true },
    });
  }

  async listMembers(workspaceId: string) {
    const rows = await this.db.membership.findMany({
      where: { workspaceId },
      select: {
        workspaceId: true,
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { email: true, displayName: true } },
      },
    });
    return rows.map(({ user, ...m }) => ({ ...m, ...user })).sort(compareMembers);
  }

  async addMember(workspaceId: string, userId: string, role: WorkspaceRole) {
    try {
      return await this.db.membership.create({
        data: { workspaceId, userId, role },
        select: { workspaceId: true, userId: true, role: true, createdAt: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async changeRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<RoleChangeResult> {
    return this.db.$transaction(async (tx) => {
      await lockWorkspace(tx, workspaceId);
      const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (membership === null) return "not_member";
      if (membership.role === "owner" && role !== "owner") {
        const owners = await tx.membership.count({ where: { workspaceId, role: "owner" } });
        if (owners <= 1) return "last_owner";
      }
      await tx.membership.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { role } });
      return "updated";
    });
  }

  async removeMember(workspaceId: string, userId: string): Promise<RemoveMemberResult> {
    return this.db.$transaction(async (tx) => {
      await lockWorkspace(tx, workspaceId);
      const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (membership === null) return "not_member";
      if (membership.role === "owner") {
        const owners = await tx.membership.count({ where: { workspaceId, role: "owner" } });
        if (owners <= 1) return "last_owner";
      }
      await tx.membership.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
      return "removed";
    });
  }

  async listRepositories(workspaceId: string) {
    return this.db.repositoryConnection.findMany({
      where: { workspaceId },
      select: repositorySelect,
      orderBy: { fullNameKey: "asc" },
    });
  }

  async findRepository(workspaceId: string, repositoryId: string) {
    return this.db.repositoryConnection.findUnique({
      where: { workspaceId_id: { workspaceId, id: repositoryId } },
      select: repositorySelect,
    });
  }

  async createRepository(input: Omit<RepositoryRecord, "createdAt">) {
    try {
      return await this.db.repositoryConnection.create({
        data: { ...input, fullNameKey: repositoryKey(input.owner, input.name) },
        select: repositorySelect,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async findRepositoryByName(workspaceId: string, owner: string, name: string) {
    return this.db.repositoryConnection.findUnique({
      where: { workspaceId_fullNameKey: { workspaceId, fullNameKey: repositoryKey(owner, name) } },
      select: repositorySelect,
    });
  }

  async deleteRepository(workspaceId: string, repositoryId: string): Promise<DeleteRepositoryResult> {
    try {
      const { count } = await this.db.repositoryConnection.deleteMany({ where: { workspaceId, id: repositoryId } });
      return count > 0 ? "deleted" : "not_found";
    } catch (error) {
      // normalized_events references the connection with NO ACTION.
      if (isForeignKeyViolation(error)) return "has_events";
      throw error;
    }
  }

  async insertEvent(input: { event: NormalizedEvent; repositoryId: string; fingerprint: string }): Promise<InsertEventResult> {
    const { event, repositoryId, fingerprint } = input;
    // ON CONFLICT DO NOTHING covers both unique keys (ID and source object) and
    // waits for a concurrent insert of the same event, so racing redeliveries
    // store exactly one row.
    const inserted = await this.db.$queryRaw<{ id: string }[]>`
      INSERT INTO normalized_events (workspace_id, id, repository_id, source, source_id, kind, occurred_at,
        repository_owner, repository_name, commit_sha, data, delivery_id, received_at, fixture, fingerprint)
      VALUES (${event.workspaceId}, ${event.id}, ${repositoryId}, ${event.source}, ${event.sourceId}, ${event.kind},
        ${new Date(event.occurredAt)}, ${event.repository.owner}, ${event.repository.name}, ${event.commitSha},
        ${JSON.stringify(event.data)}::jsonb, ${event.provenance.deliveryId}, ${new Date(event.provenance.receivedAt)},
        ${event.provenance.fixture ?? null}, ${fingerprint})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    if (inserted.length > 0) return { outcome: "created" };

    const existing = await this.db.$queryRaw<{ id: string; fingerprint: string }[]>`
      SELECT id, fingerprint FROM normalized_events
      WHERE workspace_id = ${event.workspaceId}
        AND (id = ${event.id} OR (source = ${event.source} AND kind = ${event.kind} AND source_id = ${event.sourceId}))
      ORDER BY id`;
    const [only] = existing;
    if (existing.length === 1 && only !== undefined && only.id === event.id && only.fingerprint === fingerprint) {
      return { outcome: "duplicate" };
    }
    return { outcome: "conflict", existingIds: existing.map((row) => row.id) };
  }

  async listEvents(workspaceId: string, query: EventQuery): Promise<EventRecord[]> {
    const filters = [Prisma.sql`workspace_id = ${workspaceId}`];
    if (query.kind !== undefined) filters.push(Prisma.sql`kind = ${query.kind}`);
    if (query.commitSha !== undefined) filters.push(Prisma.sql`commit_sha = ${query.commitSha}`);
    if (query.repositoryId !== undefined) filters.push(Prisma.sql`repository_id = ${query.repositoryId}`);
    const { after } = query;
    if (after !== undefined) {
      filters.push(
        Prisma.sql`(${timelineKey}) > (${new Date(after.occurredAt)}::timestamptz, ${after.source}, ${after.sourceId}, ${after.id})`,
      );
    }
    const rows = await this.db.$queryRaw<EventRow[]>`
      SELECT ${eventColumns} FROM normalized_events
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY ${timelineKey}
      LIMIT ${query.limit}`;
    return rows.map(toEventRecord);
  }

  async findEvent(workspaceId: string, eventId: string) {
    const rows = await this.db.$queryRaw<EventRow[]>`
      SELECT ${eventColumns} FROM normalized_events WHERE workspace_id = ${workspaceId} AND id = ${eventId}`;
    const [row] = rows;
    return row === undefined ? null : toEventRecord(row);
  }
}

async function lockWorkspace(tx: Prisma.TransactionClient, workspaceId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
}
