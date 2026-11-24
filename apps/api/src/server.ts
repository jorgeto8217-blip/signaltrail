import Fastify from "fastify";

export interface ServerOptions {
  logger?: boolean;
}

export function buildServer(options: ServerOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });

  app.get("/health", async () => ({ status: "ok", service: "signaltrail-api" }));

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const port = Number(process.env.API_PORT ?? 4000);
  const host = process.env.API_HOST ?? "127.0.0.1";
  const app = buildServer();
  app.listen({ port, host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
