import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMembership, requireUser } from "../auth/guard.js";
import { WORKSPACE_ROLES } from "../auth/roles.js";
import { alreadyMember, lastOwner, memberNotFound, userNotFound } from "../errors.js";
import { looksLikeId, newId } from "../ids.js";
import type { MemberRecord, Store, WorkspaceRecord } from "../store/types.js";
import { parseBody } from "./validation.js";

const CreateWorkspaceBody = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const AddMemberBody = z
  .object({ email: z.string().trim().email().max(254), role: z.enum(WORKSPACE_ROLES) })
  .strict();
const ChangeRoleBody = z.object({ role: z.enum(WORKSPACE_ROLES) }).strict();

type WsParams = { workspaceId: string };
type MemberParams = WsParams & { userId: string };

const workspaceView = (w: WorkspaceRecord) => ({ id: w.id, name: w.name, createdAt: w.createdAt.toISOString() });
const memberView = (m: MemberRecord) => ({
  userId: m.userId,
  email: m.email,
  displayName: m.displayName,
  role: m.role,
  joinedAt: m.createdAt.toISOString(),
});

export function registerWorkspaceRoutes(app: FastifyInstance, store: Store): void {
  app.get("/v1/workspaces", async (request) => {
    const user = await requireUser(request, store);
    const workspaces = await store.listWorkspacesForUser(user.id);
    return { data: workspaces.map((w) => ({ ...workspaceView(w), role: w.role })) };
  });

  app.post("/v1/workspaces", async (request, reply) => {
    const user = await requireUser(request, store);
    const body = parseBody(CreateWorkspaceBody, request.body);
    const workspace = await store.createWorkspace({ id: newId("ws"), name: body.name, ownerId: user.id });
    reply.code(201);
    return { data: { ...workspaceView(workspace), role: "owner" } };
  });

  app.get<{ Params: WsParams }>("/v1/workspaces/:workspaceId", async (request) => {
    const { workspaceId } = request.params;
    const { membership } = await requireMembership(request, store, workspaceId, "viewer");
    const workspace = (await store.findWorkspace(workspaceId))!;
    return { data: { ...workspaceView(workspace), role: membership.role } };
  });

  app.get<{ Params: WsParams }>("/v1/workspaces/:workspaceId/members", async (request) => {
    const { workspaceId } = request.params;
    await requireMembership(request, store, workspaceId, "viewer");
    return { data: (await store.listMembers(workspaceId)).map(memberView) };
  });

  app.post<{ Params: WsParams }>("/v1/workspaces/:workspaceId/members", async (request, reply) => {
    const { workspaceId } = request.params;
    await requireMembership(request, store, workspaceId, "owner");
    const body = parseBody(AddMemberBody, request.body);
    const user = await store.findUserByEmail(body.email);
    if (user === null) throw userNotFound();
    const membership = await store.addMember(workspaceId, user.id, body.role);
    if (membership === null) throw alreadyMember();
    reply.code(201);
    return { data: memberView({ ...membership, email: user.email, displayName: user.displayName }) };
  });

  app.patch<{ Params: MemberParams }>("/v1/workspaces/:workspaceId/members/:userId", async (request) => {
    const { workspaceId, userId } = request.params;
    await requireMembership(request, store, workspaceId, "owner");
    const body = parseBody(ChangeRoleBody, request.body);
    if (!looksLikeId("usr", userId)) throw memberNotFound();
    const result = await store.changeRole(workspaceId, userId, body.role);
    if (result === "not_member") throw memberNotFound();
    if (result === "last_owner") throw lastOwner();
    const member = (await store.listMembers(workspaceId)).find((m) => m.userId === userId)!;
    return { data: memberView(member) };
  });

  app.delete<{ Params: MemberParams }>("/v1/workspaces/:workspaceId/members/:userId", async (request, reply) => {
    const { workspaceId, userId } = request.params;
    await requireMembership(request, store, workspaceId, "owner");
    if (!looksLikeId("usr", userId)) throw memberNotFound();
    const result = await store.removeMember(workspaceId, userId);
    if (result === "not_member") throw memberNotFound();
    if (result === "last_owner") throw lastOwner();
    reply.code(204);
  });
}
