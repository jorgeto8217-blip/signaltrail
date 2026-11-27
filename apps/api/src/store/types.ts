import type { EventKind, NormalizedEvent } from "@signaltrail/contracts";
import type { WorkspaceRole } from "../auth/roles.js";
import type { EventCursor } from "../events/canonical.js";

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  createdAt: Date;
}

export interface MembershipRecord {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: Date;
}

export interface MemberRecord extends MembershipRecord {
  email: string;
  displayName: string;
}

export interface RepositoryRecord {
  id: string;
  workspaceId: string;
  owner: string;
  name: string;
  createdById: string;
  createdAt: Date;
}

/** A stored event: the canonical contract event plus where SignalTrail filed it. */
export interface EventRecord {
  event: NormalizedEvent;
  repositoryId: string;
  recordedAt: Date;
}

/**
 * - created:   stored now
 * - duplicate: the same event (same ID, identical content) was already stored
 * - conflict:  the ID or the source object is already stored with different content;
 *              the stored event is kept, `existingIds` names it
 */
export type InsertEventResult =
  | { outcome: "created" | "duplicate" }
  | { outcome: "conflict"; existingIds: string[] };

export interface EventQuery {
  /** Return events strictly after this timeline position. */
  after?: EventCursor;
  limit: number;
  kind?: EventKind;
  commitSha?: string;
  repositoryId?: string;
}

export type DeleteRepositoryResult = "deleted" | "not_found" | "has_events";

export type RoleChangeResult = "updated" | "not_member" | "last_owner";
export type RemoveMemberResult = "removed" | "not_member" | "last_owner";

/**
 * Persistence used by the API. Every workspace-owned read and write takes the
 * workspace ID, so a query cannot reach another tenant's rows by record ID alone.
 */
export interface Store {
  findUserByTokenHash(tokenHash: string): Promise<UserRecord | null>;
  findUserByEmail(email: string): Promise<UserRecord | null>;

  createWorkspace(input: { id: string; name: string; ownerId: string }): Promise<WorkspaceRecord>;
  findWorkspace(workspaceId: string): Promise<WorkspaceRecord | null>;
  listWorkspacesForUser(userId: string): Promise<(WorkspaceRecord & { role: WorkspaceRole })[]>;

  findMembership(workspaceId: string, userId: string): Promise<MembershipRecord | null>;
  listMembers(workspaceId: string): Promise<MemberRecord[]>;
  /** Returns null when the user is already a member. */
  addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<MembershipRecord | null>;
  /** Refuses to demote the workspace's last owner. */
  changeRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<RoleChangeResult>;
  /** Refuses to remove the workspace's last owner. */
  removeMember(workspaceId: string, userId: string): Promise<RemoveMemberResult>;

  listRepositories(workspaceId: string): Promise<RepositoryRecord[]>;
  findRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  /** Returns null when the workspace already has this owner/name (case-insensitive). */
  createRepository(input: Omit<RepositoryRecord, "createdAt">): Promise<RepositoryRecord | null>;
  findRepositoryByName(workspaceId: string, owner: string, name: string): Promise<RepositoryRecord | null>;
  /** Refuses to delete a repository that still has events. */
  deleteRepository(workspaceId: string, repositoryId: string): Promise<DeleteRepositoryResult>;

  /** Stores a canonical event once; `fingerprint` decides duplicate vs conflict. */
  insertEvent(input: { event: NormalizedEvent; repositoryId: string; fingerprint: string }): Promise<InsertEventResult>;
  /** Events in stable timeline order (see `compareEvents` in the contract). */
  listEvents(workspaceId: string, query: EventQuery): Promise<EventRecord[]>;
  findEvent(workspaceId: string, eventId: string): Promise<EventRecord | null>;
}

/** GitHub owner and repository names are case-insensitive. */
export function repositoryKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

/** Stable member order: role (owners first), then email. */
export function compareMembers(a: MemberRecord, b: MemberRecord): number {
  const order = { owner: 0, maintainer: 1, viewer: 2 } as const;
  return order[a.role] - order[b.role] || a.email.localeCompare(b.email);
}
