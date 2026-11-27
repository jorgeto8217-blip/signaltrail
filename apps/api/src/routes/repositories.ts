import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMembership } from "../auth/guard.js";
import { repositoryExists, repositoryHasEvents, repositoryNotFound } from "../errors.js";
import { looksLikeId, newId } from "../ids.js";
import type { RepositoryRecord, Store } from "../store/types.js";
import { parseBody } from "./validation.js";

// GitHub limits: owners are 1–39 letters, digits or single hyphens; repository
// names are up to 100 letters, digits, '.', '_' or '-', and not "." or "..".
const ownerName = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, "must be a valid GitHub owner name");
const repoName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}$/, "must be a valid GitHub repository name")
  .refine((n) => n !== "." && n !== "..", "must be a valid GitHub repository name");

const ConnectRepositoryBody = z.object({ owner: ownerName, name: repoName }).strict();

type WsParams = { workspaceId: string };
type RepoParams = WsParams & { repositoryId: string };

const repositoryView = (r: RepositoryRecord) => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  fullName: `${r.owner}/${r.name}`,
  createdById: r.createdById,
  createdAt: r.createdAt.toISOString(),
});

export function registerRepositoryRoutes(app: FastifyInstance, store: Store): void {
  app.get<{ Params: WsParams }>("/v1/workspaces/:workspaceId/repositories", async (request) => {
    const { workspaceId } = request.params;
    await requireMembership(request, store, workspaceId, "viewer");
    return { data: (await store.listRepositories(workspaceId)).map(repositoryView) };
  });

  app.post<{ Params: WsParams }>("/v1/workspaces/:workspaceId/repositories", async (request, reply) => {
    const { workspaceId } = request.params;
    const { user } = await requireMembership(request, store, workspaceId, "maintainer");
    const body = parseBody(ConnectRepositoryBody, request.body);
    const repository = await store.createRepository({
      id: newId("repo"),
      workspaceId,
      owner: body.owner,
      name: body.name,
      createdById: user.id,
    });
    if (repository === null) throw repositoryExists();
    reply.code(201);
    return { data: repositoryView(repository) };
  });

  app.get<{ Params: RepoParams }>("/v1/workspaces/:workspaceId/repositories/:repositoryId", async (request) => {
    const { workspaceId, repositoryId } = request.params;
    await requireMembership(request, store, workspaceId, "viewer");
    const repository = looksLikeId("repo", repositoryId) ? await store.findRepository(workspaceId, repositoryId) : null;
    if (repository === null) throw repositoryNotFound();
    return { data: repositoryView(repository) };
  });

  app.delete<{ Params: RepoParams }>(
    "/v1/workspaces/:workspaceId/repositories/:repositoryId",
    async (request, reply) => {
      const { workspaceId, repositoryId } = request.params;
      await requireMembership(request, store, workspaceId, "maintainer");
      const result = looksLikeId("repo", repositoryId)
        ? await store.deleteRepository(workspaceId, repositoryId)
        : "not_found";
      if (result === "not_found") throw repositoryNotFound();
      if (result === "has_events") throw repositoryHasEvents();
      reply.code(204);
    },
  );
}
