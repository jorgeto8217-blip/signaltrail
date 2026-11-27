import { Prisma, type PrismaClient } from "@prisma/client";
import type { WorkspaceRole } from "../auth/roles.js";
import {
  compareMembers,
  repositoryKey,
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

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
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

  async deleteRepository(workspaceId: string, repositoryId: string) {
    const { count } = await this.db.repositoryConnection.deleteMany({ where: { workspaceId, id: repositoryId } });
    return count > 0;
  }
}

async function lockWorkspace(tx: Prisma.TransactionClient, workspaceId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
}
