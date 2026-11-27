import { readFileSync } from "node:fs";
import { compareEvents, type NormalizedEvent } from "@signaltrail/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup } from "../test-support.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../packages/contracts/fixtures/checkout-outage.json", import.meta.url), "utf8"),
) as { events: NormalizedEvent[] };

/** The checkout-outage fixture, moved into `workspaceId`. */
function outage(workspaceId: string): NormalizedEvent[] {
  return structuredClone(fixture.events).map((e) => ({ ...e, workspaceId }));
}

let ctx = setup();
let acme: string;
let globex: string;
let url: string;

beforeEach(async () => {
  ({ acme, globex } = await ctx.twoWorkspaces());
  url = `/v1/workspaces/${acme}/events`;
  // The fixture uses two repositories; twoWorkspaces connected neither.
  for (const name of ["checkout-service", "storefront-docs"]) {
    await ctx.call("olivia", "POST", `/v1/workspaces/${acme}/repositories`, { owner: "acme-demo", name });
  }
});

afterEach(async () => {
  await ctx.app.close();
  ctx = setup();
});

describe("storing events", () => {
  it("stores a replayed fixture once and reports redeliveries as duplicates", async () => {
    const first = await ctx.call("marco", "POST", url, { events: outage(acme) });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ created: 8, duplicate: 0, conflict: 0 });

    const again = await ctx.call("marco", "POST", url, { events: outage(acme) });
    expect(again.json().data).toMatchObject({ created: 0, duplicate: 8, conflict: 0 });

    const list = (await ctx.call("vera", "GET", url)).json();
    expect(list.data).toHaveLength(8);
    expect(list.nextCursor).toBeNull();
  });

  it("treats a redelivery that only reformats timestamps as the same event", async () => {
    const [event] = outage(acme);
    await ctx.call("marco", "POST", url, { events: [event] });
    const reformatted = {
      ...event!,
      occurredAt: event!.occurredAt.replace("Z", ".000Z"),
      provenance: { ...event!.provenance, receivedAt: event!.provenance.receivedAt.replace("Z", ".000Z") },
    };
    const res = await ctx.call("marco", "POST", url, { events: [reformatted] });
    expect(res.json().data.results).toEqual([{ id: event!.id, outcome: "duplicate" }]);
  });

  it("keeps the first version when an ID or source object is reused with different content", async () => {
    const [event] = outage(acme);
    await ctx.call("marco", "POST", url, { events: [event] });

    const changed = { ...event!, data: { ...event!.data, title: "Rewritten title" } } as NormalizedEvent;
    const sameSourceNewId = { ...event!, id: "evt_pr_412_again" };
    const res = await ctx.call("marco", "POST", url, { events: [changed, sameSourceNewId] });
    expect(res.json().data).toMatchObject({ created: 0, conflict: 2 });
    expect(res.json().data.results).toEqual([
      { id: event!.id, outcome: "conflict", existingIds: [event!.id] },
      { id: "evt_pr_412_again", outcome: "conflict", existingIds: [event!.id] },
    ]);

    const stored = (await ctx.call("vera", "GET", `${url}/${event!.id}`)).json().data;
    expect(stored.data.title).toBe("Retry card authorization on gateway timeout");
    expect((await ctx.call("vera", "GET", `${url}/evt_pr_412_again`)).statusCode).toBe(404);
  });

  it("returns the stored event with its repository and canonical timestamps", async () => {
    const [event] = outage(acme);
    await ctx.call("marco", "POST", url, { events: [event] });
    const repos = (await ctx.call("vera", "GET", `/v1/workspaces/${acme}/repositories`)).json().data;
    const checkout = repos.find((r: { name: string }) => r.name === "checkout-service");

    const res = await ctx.call("vera", "GET", `${url}/${event!.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      ...event,
      occurredAt: "2026-03-10T14:02:11.000Z",
      provenance: { ...event!.provenance, receivedAt: "2026-03-10T14:02:12.000Z" },
      repositoryId: checkout.id,
      recordedAt: expect.any(String),
    });
  });

  it("lets maintainers and owners store events, but not viewers", async () => {
    const events = outage(acme).slice(0, 1);
    expect((await ctx.call("vera", "POST", url, { events })).statusCode).toBe(403);
    expect((await ctx.call("olivia", "POST", url, { events })).statusCode).toBe(200);
    expect((await ctx.call(null, "POST", url, { events })).statusCode).toBe(401);
  });

  it("rejects the whole request when any event breaks the contract", async () => {
    const events = outage(acme);
    (events[3] as { commitSha: string }).commitSha = "3f9c2a7";
    const res = await ctx.call("marco", "POST", url, { events });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.issues).toEqual([
      expect.objectContaining({ path: "events.3.commitSha" }),
    ]);
    expect((await ctx.call("vera", "GET", url)).json().data).toEqual([]);
  });

  it.each([
    ["an empty batch", { events: [] }],
    ["a missing events array", {}],
    ["unknown top-level fields", { events: outage("ws_x").slice(0, 1), extra: 1 }],
  ])("rejects %s", async (_label, payload) => {
    expect((await ctx.call("marco", "POST", url, payload)).statusCode).toBe(400);
  });

  it("rejects events for another workspace, from GitHub, unmarked or from unconnected repositories", async () => {
    const [a, b, c, d, e] = outage(acme);
    const events = [
      { ...a!, workspaceId: globex },
      { ...b!, source: "github" },
      { ...c!, provenance: { deliveryId: "d-1", receivedAt: c!.provenance.receivedAt } },
      { ...d!, repository: { owner: "acme-demo", name: "not-connected" } },
      { ...e!, id: `evt_${"x".repeat(65)}` },
    ];
    const res = await ctx.call("marco", "POST", url, { events });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_events");
    expect(res.json().error.details.issues.map((i: { path: string }) => i.path)).toEqual([
      "events.0.workspaceId",
      "events.1.source",
      "events.2.provenance.fixture",
      "events.3.repository",
      "events.4.id",
    ]);
    expect((await ctx.call("vera", "GET", url)).json().data).toEqual([]);
  });

  it("matches repositories case-insensitively, as GitHub does", async () => {
    const [event] = outage(acme);
    const res = await ctx.call("marco", "POST", url, {
      events: [{ ...event!, repository: { owner: "ACME-demo", name: "Checkout-Service" } }],
    });
    expect(res.json().data.created).toBe(1);
    const stored = (await ctx.call("vera", "GET", `${url}/${event!.id}`)).json().data;
    expect(stored.repository).toEqual({ owner: "ACME-demo", name: "Checkout-Service" });
  });

  it("accepts a batch of up to 500 events", async () => {
    const [template] = outage(acme);
    const events = Array.from({ length: 501 }, (_, i) => ({ ...template!, id: `evt_bulk_${i}`, sourceId: `pr-${i}` }));
    expect((await ctx.call("marco", "POST", url, { events })).statusCode).toBe(400);
    const res = await ctx.call("marco", "POST", url, { events: events.slice(0, 500) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.created).toBe(500);
  });
});

describe("reading events", () => {
  beforeEach(async () => {
    // Store in reverse to show the read order does not depend on insert order.
    await ctx.call("marco", "POST", url, { events: outage(acme).reverse() });
  });

  it("lists events in stable timeline order", async () => {
    const data = (await ctx.call("vera", "GET", url)).json().data as NormalizedEvent[];
    expect(data.map((e) => e.id)).toEqual(fixture.events.map((e) => e.id));
    expect([...data].sort(compareEvents)).toEqual(data);
  });

  it("pages with a cursor without skipping or repeating events", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "?limit=3" : `?limit=3&cursor=${cursor}`;
      const page = (await ctx.call("vera", "GET", `${url}${query}`)).json();
      expect(page.data.length).toBeLessThanOrEqual(3);
      seen.push(...page.data.map((e: NormalizedEvent) => e.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(fixture.events.map((e) => e.id));
  });

  it("filters by kind, commit and repository", async () => {
    const deploys = (await ctx.call("vera", "GET", `${url}?kind=deployment.status`)).json().data;
    expect(deploys.every((e: NormalizedEvent) => e.kind === "deployment.status")).toBe(true);
    expect(deploys.length).toBeGreaterThan(0);

    const sha = fixture.events[0]!.commitSha!;
    const bySha = (await ctx.call("vera", "GET", `${url}?commitSha=${sha}`)).json().data;
    expect(bySha.map((e: NormalizedEvent) => e.id)).toEqual(
      fixture.events.filter((e) => e.commitSha === sha).map((e) => e.id),
    );

    const repos = (await ctx.call("vera", "GET", `/v1/workspaces/${acme}/repositories`)).json().data;
    const docs = repos.find((r: { name: string }) => r.name === "storefront-docs");
    const byRepo = (await ctx.call("vera", "GET", `${url}?repositoryId=${docs.id}`)).json().data;
    expect(byRepo).toHaveLength(2);
    expect(byRepo.every((e: { repositoryId: string }) => e.repositoryId === docs.id)).toBe(true);
  });

  it.each([
    ["limit=0"],
    ["limit=201"],
    ["kind=deployment.rolled_back"],
    ["commitSha=3f9c2a7"],
    ["unknown=1"],
  ])("rejects the query %s", async (query) => {
    const res = await ctx.call("vera", "GET", `${url}?${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it.each([["not-base64!"], [Buffer.from('["x"]').toString("base64url")], [Buffer.from("{").toString("base64url")]])(
    "rejects the forged cursor %s",
    async (cursor) => {
      const res = await ctx.call("vera", "GET", `${url}?cursor=${cursor}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_cursor");
    },
  );

  it("never shows one workspace's events to another", async () => {
    const id = fixture.events[0]!.id;
    expect((await ctx.call("gabe", "GET", url)).statusCode).toBe(404);
    expect((await ctx.call("gabe", "GET", `${url}/${id}`)).statusCode).toBe(404);
    expect((await ctx.call("gabe", "GET", `/v1/workspaces/${globex}/events`)).json().data).toEqual([]);
    const foreign = await ctx.call("gabe", "GET", `/v1/workspaces/${globex}/events/${id}`);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("event_not_found");
    // Gabe cannot write into Acme either.
    expect((await ctx.call("gabe", "POST", url, { events: outage(acme) })).statusCode).toBe(404);
  });

  it("returns 404 for unknown and malformed event IDs", async () => {
    for (const id of ["evt_nope", "not-an-id"]) {
      const res = await ctx.call("vera", "GET", `${url}/${id}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("event_not_found");
    }
  });

  it("keeps a repository connected while it has events", async () => {
    const repos = (await ctx.call("vera", "GET", `/v1/workspaces/${acme}/repositories`)).json().data;
    const docs = repos.find((r: { name: string }) => r.name === "storefront-docs");
    const res = await ctx.call("olivia", "DELETE", `/v1/workspaces/${acme}/repositories/${docs.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("repository_has_events");

    const unused = repos.find((r: { name: string }) => r.name === "checkout");
    expect((await ctx.call("olivia", "DELETE", `/v1/workspaces/${acme}/repositories/${unused.id}`)).statusCode).toBe(204);
  });
});
