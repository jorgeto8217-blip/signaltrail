import type { WorkspaceRole } from "../auth/roles.js";
import {
  compareMembers,
  repositoryKey,
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

  async deleteRepository(workspaceId: string, repositoryId: string) {
    const repository = this.repositories.get(repositoryId);
    if (repository === undefined || repository.workspaceId !== workspaceId) return false;
    this.repositories.delete(repositoryId);
    return true;
  }
}

function strip({ key: _key, ...repository }: RepositoryRecord & { key: string }): RepositoryRecord {
  return { ...repository };
}
