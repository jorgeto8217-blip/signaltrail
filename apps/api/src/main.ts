import { PrismaClient } from "@prisma/client";
import { buildServer } from "./server.js";
import { PrismaStore } from "./store/prisma.js";

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? "127.0.0.1";

const db = new PrismaClient();
const app = buildServer({ store: new PrismaStore(db) });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => db.$disconnect()).then(() => process.exit(0));
  });
}

app.listen({ port, host }).catch(async (err) => {
  app.log.error(err);
  await db.$disconnect();
  process.exit(1);
});
