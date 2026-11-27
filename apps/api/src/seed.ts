/**
 * Seeds two synthetic workspaces for local development and prints a fresh API
 * token for each demo user (earlier seed tokens are revoked). Safe to re-run:
 * records are upserted. All names and emails are fictional. The synthetic
 * `checkout-outage` fixture is stored in `ws_demo`; events already stored are
 * reported as duplicates.
 */
import { readFile } from "node:fs/promises";
import { PrismaClient, type WorkspaceRole } from "@prisma/client";
import { validateFixture } from "@signaltrail/contracts";
import { generateToken, hashToken } from "./auth/tokens.js";
import { canonicalEvent, eventFingerprint } from "./events/canonical.js";
import { newId } from "./ids.js";
import { PrismaStore } from "./store/prisma.js";
import { repositoryKey } from "./store/types.js";

const fixtureUrl = new URL("../../../packages/contracts/fixtures/checkout-outage.json", import.meta.url);

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo users when NODE_ENV=production.");
  process.exit(1);
}

const workspaces = [
  { id: "ws_demo", name: "Acme checkout (demo)" },
  { id: "ws_globex_demo", name: "Globex payments (demo)" },
] as const;

const users: { id: string; email: string; displayName: string; roles: Record<string, WorkspaceRole> }[] = [
  { id: "usr_olivia_owner", email: "olivia.owner@example.test", displayName: "Olivia (owner)", roles: { ws_demo: "owner" } },
  {
    id: "usr_marco_maintainer",
    email: "marco.maintainer@example.test",
    displayName: "Marco (maintainer)",
    roles: { ws_demo: "maintainer" },
  },
  {
    id: "usr_vera_viewer",
    email: "vera.viewer@example.test",
    displayName: "Vera (viewer)",
    roles: { ws_demo: "viewer", ws_globex_demo: "viewer" },
  },
  {
    id: "usr_gabe_globex",
    email: "gabe.owner@example.test",
    displayName: "Gabe (Globex owner)",
    roles: { ws_globex_demo: "owner" },
  },
];

const repositories = [
  { id: "repo_demo_checkout", workspaceId: "ws_demo", owner: "acme-demo", name: "checkout-service" },
  { id: "repo_demo_docs", workspaceId: "ws_demo", owner: "acme-demo", name: "storefront-docs" },
  { id: "repo_globex_payments", workspaceId: "ws_globex_demo", owner: "globex-demo", name: "payments-api" },
] as const;

const db = new PrismaClient();

async function main() {
  for (const ws of workspaces) {
    await db.workspace.upsert({ where: { id: ws.id }, create: ws, update: { name: ws.name } });
  }

  const issued: { email: string; token: string }[] = [];
  for (const user of users) {
    const { roles, ...fields } = user;
    await db.user.upsert({ where: { id: user.id }, create: fields, update: fields });
    for (const [workspaceId, role] of Object.entries(roles)) {
      await db.membership.upsert({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
        create: { workspaceId, userId: user.id, role },
        update: { role },
      });
    }
    const token = generateToken();
    await db.$transaction([
      db.apiToken.updateMany({ where: { userId: user.id, label: "seed", revokedAt: null }, data: { revokedAt: new Date() } }),
      db.apiToken.create({ data: { id: newId("tok"), userId: user.id, tokenHash: hashToken(token), label: "seed" } }),
    ]);
    issued.push({ email: user.email, token });
  }

  for (const repo of repositories) {
    await db.repositoryConnection.upsert({
      where: { id: repo.id },
      create: { ...repo, fullNameKey: repositoryKey(repo.owner, repo.name), createdById: "usr_olivia_owner" },
      update: {},
    });
  }

  const fixture = validateFixture(JSON.parse(await readFile(fixtureUrl, "utf8")));
  if (!fixture.ok) throw new Error(`checkout-outage fixture is invalid: ${JSON.stringify(fixture.issues)}`);
  const store = new PrismaStore(db);
  const outcomes = { created: 0, duplicate: 0, conflict: 0 };
  for (const raw of fixture.fixture.events) {
    const event = canonicalEvent(raw);
    const repository = await store.findRepositoryByName(event.workspaceId, event.repository.owner, event.repository.name);
    if (repository === null) throw new Error(`fixture repository ${event.repository.owner}/${event.repository.name} is not seeded`);
    const result = await store.insertEvent({ event, repositoryId: repository.id, fingerprint: eventFingerprint(event) });
    outcomes[result.outcome] += 1;
  }

  console.log("Seeded workspaces:", workspaces.map((w) => w.id).join(", "));
  console.log(
    `checkout-outage events in ws_demo: ${outcomes.created} created, ${outcomes.duplicate} already stored, ${outcomes.conflict} conflicting`,
  );
  if (outcomes.conflict > 0) process.exitCode = 1;
  console.log("API tokens (local use only; re-running the seed revokes them):");
  for (const { email, token } of issued) console.log(`  ${email.padEnd(32)} ${token}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
