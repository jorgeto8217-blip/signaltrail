import type { FastifyRequest } from "fastify";
import { forbidden, unauthorized, workspaceNotFound } from "../errors.js";
import { looksLikeId } from "../ids.js";
import type { MembershipRecord, Store, UserRecord } from "../store/types.js";
import { hasRole, type WorkspaceRole } from "./roles.js";
import { hashToken, readBearerToken } from "./tokens.js";

export async function requireUser(request: FastifyRequest, store: Store): Promise<UserRecord> {
  const token = readBearerToken(request.headers.authorization);
  if (token === null) throw unauthorized();
  const user = await store.findUserByTokenHash(hashToken(token));
  if (user === null) throw unauthorized();
  return user;
}

/**
 * Authenticates the caller, then checks their membership and role in the
 * workspace. The membership is read on every request, so a role change or
 * removal takes effect immediately. Unknown workspaces, malformed IDs and
 * workspaces the caller does not belong to all return the same 404.
 */
export async function requireMembership(
  request: FastifyRequest,
  store: Store,
  workspaceId: string,
  required: WorkspaceRole,
): Promise<{ user: UserRecord; membership: MembershipRecord }> {
  const user = await requireUser(request, store);
  if (!looksLikeId("ws", workspaceId)) throw workspaceNotFound();
  const membership = await store.findMembership(workspaceId, user.id);
  if (membership === null) throw workspaceNotFound();
  if (!hasRole(membership.role, required)) throw forbidden(required);
  return { user, membership };
}
