import Fastify, { type FastifyError } from "fastify";
import { HttpError } from "./errors.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerRepositoryRoutes } from "./routes/repositories.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import type { Store } from "./store/types.js";

export interface ServerOptions {
  logger?: boolean;
  store: Store;
}

export function buildServer(options: ServerOptions) {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 64 * 1024 });

  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    if (error instanceof HttpError) {
      const body: Record<string, unknown> = { code: error.code, message: error.message };
      if (error.details !== undefined) body.details = error.details;
      return reply.code(error.statusCode).send({ error: body });
    }
    // Fastify's own client errors (malformed JSON, unsupported media type, body too large).
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "bad_request", message: error.message } });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal", message: "Something went wrong." } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "Route not found." } }),
  );

  app.get("/health", async () => ({ status: "ok", service: "signaltrail-api" }));
  registerWorkspaceRoutes(app, options.store);
  registerRepositoryRoutes(app, options.store);
  registerEventRoutes(app, options.store);

  return app;
}
