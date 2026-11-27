import { compareEvents, type NormalizedEvent } from "@signaltrail/contracts";
import type { WorkspaceRole } from "../auth/roles.js";
import type { EventCursor } from "../events/canonical.js";
import {
  compareMembers,
  repositoryKey,
  type DeleteRepositoryResult,
  type EventQuery,
  type EventRecord,
  type InsertEventResult,
  type MemberRecord,
  type MembershipRecord,
  type RemoveMemberResult,
  type RepositoryRecord,
  type RoleChangeResult,
  type Store,
  type UserRecord,
  type WorkspaceRecord,
} from "./types.js";

/** In-process store for tests and local experiments. Same rules as the PostgreSQL store. */
export class MemoryStore implements Store {
  private readonly users = new Map<string, UserRecord>();
  private readonly tokens = new Map<string, string>(); // token hash → user ID
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly memberships = new Map<string, MembershipRecord>(); // "<ws>:<user>"
  private readonly repositories = new Map<string, RepositoryRecord & { key: string }>();
  private readonly events = new Map<string, EventRecord & { fingerprint: string }>(); // "<ws>:<event id>"
  private readonly eventSources = new Map<string, string>(); // "<ws>:<source>:<kind>:<source id>" → event ID
  private clock = 0;

  /** Test helper: a user plus one API token hash. */
  addUser(user: UserRecord, tokenHash: string): void {
    this.users.set(user.id, { ...user });
    this.tokens.set(tokenHash, user.id);
  }

  /** Strictly increasing timestamps keep ordering deterministic in tests. */
  private now(): Date {
    this.clock += 1;
    return new Date(Date.UTC(2026, 0, 1) + this.clock);
  }

  async findUserByTokenHash(tokenHash: string) {
    const userId = this.tokens.get(tokenHash);
    return userId === undefined ? null : { ...this.users.get(userId)! };
  }

  async findUserByEmail(email: string) {
    const wanted = email.toLowerCase();
    for (const user of this.users.values()) if (user.email.toLowerCase() === wanted) return { ...user };
    return null;
  }

  async createWorkspace(input: { id: string; name: string; ownerId: string }) {
    const workspace = { id: input.id, name: input.name, createdAt: this.now() };
    this.workspaces.set(workspace.id, workspace);
    this.memberships.set(`${workspace.id}:${input.ownerId}`, {
      workspaceId: workspace.id,
      userId: input.ownerId,
      role: "owner",
      createdAt: workspace.createdAt,
    });
    return { ...workspace };
  }

  async findWorkspace(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId);
    return workspace === undefined ? null : { ...workspace };
  }

  async listWorkspacesForUser(userId: string) {
    return [...this.memberships.values()]
      .filter((m) => m.userId === userId)
      .map((m) => ({ ...this.workspaces.get(m.workspaceId)!, role: m.role }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async findMembership(workspaceId: string, userId: string) {
    const membership = this.memberships.get(`${workspaceId}:${userId}`);
    return membership === undefined ? null : { ...membership };
  }

  async listMembers(workspaceId: string): Promise<MemberRecord[]> {
    return [...this.memberships.values()]
      .filter((m) => m.workspaceId === workspaceId)
      .map((m) => {
        const user = this.users.get(m.userId)!;
        return { ...m, email: user.email, displayName: user.displayName };
      })
      .sort(compareMembers);
  }

  async addMember(workspaceId: string, userId: string, role: WorkspaceRole) {
    const key = `${workspaceId}:${userId}`;
    if (this.memberships.has(key)) return null;
    const membership = { workspaceId, userId, role, createdAt: this.now() };
    this.memberships.set(key, membership);
    return { ...membership };
  }

  private ownerCount(workspaceId: string): number {
    return [...this.memberships.values()].filter((m) => m.workspaceId === workspaceId && m.role === "owner")
      .length;
  }

  async changeRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<RoleChangeResult> {
    const membership = this.memberships.get(`${workspaceId}:${userId}`);
    if (membership === undefined) return "not_member";
    if (membership.role === "owner" && role !== "owner" && this.ownerCount(workspaceId) === 1) return "last_owner";
    membership.role = role;
    return "updated";
  }

  async removeMember(workspaceId: string, userId: string): Promise<RemoveMemberResult> {
    const key = `${workspaceId}:${userId}`;
    const membership = this.memberships.get(key);
    if (membership === undefined) return "not_member";
    if (membership.role === "owner" && this.ownerCount(workspaceId) === 1) return "last_owner";
    this.memberships.delete(key);
    return "removed";
  }

  async listRepositories(workspaceId: string) {
    return [...this.repositories.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(strip);
  }

  async findRepository(workspaceId: string, repositoryId: string) {
    const repository = this.repositories.get(repositoryId);
    return repository === undefined || repository.workspaceId !== workspaceId ? null : strip(repository);
  }

  async createRepository(input: Omit<RepositoryRecord, "createdAt">) {
    const key = repositoryKey(input.owner, input.name);
    for (const r of this.repositories.values()) if (r.workspaceId === input.workspaceId && r.key === key) return null;
    const repository = { ...input, key, createdAt: this.now() };
    this.repositories.set(repository.id, repository);
    return strip(repository);
  }

  async findRepositoryByName(workspaceId: string, owner: string, name: string) {
    const key = repositoryKey(owner, name);
    for (const r of this.repositories.values()) {
      if (r.workspaceId === workspaceId && r.key === key) return strip(r);
    }
    return null;
  }

  async deleteRepository(workspaceId: string, repositoryId: string): Promise<DeleteRepositoryResult> {
    const repository = this.repositories.get(repositoryId);
    if (repository === undefined || repository.workspaceId !== workspaceId) return "not_found";
    for (const e of this.events.values()) {
      if (e.event.workspaceId === workspaceId && e.repositoryId === repositoryId) return "has_events";
    }
    this.repositories.delete(repositoryId);
    return "deleted";
  }

  async insertEvent(input: { event: NormalizedEvent; repositoryId: string; fingerprint: string }): Promise<InsertEventResult> {
    const { event } = input;
    const idKey = `${event.workspaceId}:${event.id}`;
    const sourceKey = `${event.workspaceId}:${event.source}:${event.kind}:${event.sourceId}`;
    const byId = this.events.get(idKey);
    const bySourceId = this.eventSources.get(sourceKey);

    if (byId === undefined && bySourceId === undefined) {
      this.events.set(idKey, { ...structuredClone(input), recordedAt: this.now() });
      this.eventSources.set(sourceKey, event.id);
      return { outcome: "created" };
    }
    if (byId !== undefined && bySourceId === event.id && byId.fingerprint === input.fingerprint) {
      return { outcome: "duplicate" };
    }
    const existingIds = [...new Set([byId?.event.id, bySourceId].filter((id): id is string => id !== undefined))];
    return { outcome: "conflict", existingIds: existingIds.sort() };
  }

  async listEvents(workspaceId: string, query: EventQuery): Promise<EventRecord[]> {
    const { after } = query;
    return [...this.events.values()]
      .filter(
        ({ event, repositoryId }) =>
          event.workspaceId === workspaceId &&
          (query.kind === undefined || event.kind === query.kind) &&
          (query.commitSha === undefined || event.commitSha === query.commitSha) &&
          (query.repositoryId === undefined || repositoryId === query.repositoryId) &&
          (after === undefined || compareToCursor(event, after) > 0),
      )
      .sort((a, b) => compareEvents(a.event, b.event))
      .slice(0, query.limit)
      .map(publicEvent);
  }

  async findEvent(workspaceId: string, eventId: string) {
    const record = this.events.get(`${workspaceId}:${eventId}`);
    return record === undefined ? null : publicEvent(record);
  }
}

function publicEvent({ fingerprint: _fingerprint, ...record }: EventRecord & { fingerprint: string }): EventRecord {
  return structuredClone(record);
}

function compareToCursor(event: NormalizedEvent, cursor: EventCursor): number {
  return compareEvents(event, { ...event, ...cursor } as NormalizedEvent);
}

function strip({ key: _key, ...repository }: RepositoryRecord & { key: string }): RepositoryRecord {
  return { ...repository };
}
