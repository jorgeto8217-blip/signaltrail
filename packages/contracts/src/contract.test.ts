import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareEvents, EVENT_KINDS, NormalizedEventSchema, type NormalizedEvent } from "./event.js";
import { sortTimeline, validateFixture, type EventFixture } from "./fixture.js";

const fixturePath = fileURLToPath(new URL("../fixtures/checkout-outage.json", import.meta.url));

async function loadOutage(): Promise<EventFixture> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as EventFixture;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("checkout-outage fixture", () => {
  it("satisfies the normalized event contract", async () => {
    const result = validateFixture(await loadOutage());

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.fixture.events).toHaveLength(8);
    expect(new Set(result.fixture.events.map((e) => e.kind))).toEqual(
      new Set(["pull_request.merged", "check_run.completed", "deployment.status", "alert.triggered"]),
    );
  });

  it("contains both an exact-SHA deployment and an unrelated deployment in the same window", async () => {
    const { events } = await loadOutage();
    const failingCheck = events.find(
      (e) => e.kind === "check_run.completed" && e.data.conclusion === "failure",
    );
    const productionDeploys = events.filter(
      (e) => e.kind === "deployment.status" && e.data.state === "success",
    );

    expect(failingCheck).toBeDefined();
    expect(productionDeploys.map((e) => e.commitSha === failingCheck?.commitSha)).toEqual([false, true]);
  });
});

describe("NormalizedEventSchema", () => {
  async function firstEvent(): Promise<NormalizedEvent> {
    const { events } = await loadOutage();
    return clone(events[0]!);
  }

  it("rejects abbreviated commit SHAs", async () => {
    const event = { ...(await firstEvent()), commitSha: "3f9c2a7" };
    const result = NormalizedEventSchema.safeParse(event);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["commitSha"]);
  });

  it("lists every event kind in EVENT_KINDS", () => {
    expect(EVENT_KINDS).toEqual(["pull_request.merged", "check_run.completed", "deployment.status", "alert.triggered"]);
  });

  it("rejects unknown event kinds", async () => {
    const event = { ...(await firstEvent()), kind: "deployment.rolled_back" };

    expect(NormalizedEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects timestamps without UTC designator", async () => {
    const event = { ...(await firstEvent()), occurredAt: "2026-03-10 14:02:11" };

    expect(NormalizedEventSchema.safeParse(event).success).toBe(false);
  });

  it("requires alerts to carry no commit SHA", async () => {
    const { events } = await loadOutage();
    const alert = clone(events.find((e) => e.kind === "alert.triggered")!);
    const withSha = { ...alert, commitSha: "3f9c2a7e1b4d8c06a5e2f7b9d1c3e4a6b8f0d2c1" };

    expect(NormalizedEventSchema.safeParse(alert).success).toBe(true);
    expect(NormalizedEventSchema.safeParse(withSha).success).toBe(false);
  });
});

describe("validateFixture", () => {
  it("reports duplicate event IDs", async () => {
    const fixture = clone(await loadOutage());
    fixture.events[1]!.id = fixture.events[0]!.id;

    const result = validateFixture(fixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ path: "events.1.id", message: "duplicate event id evt_pr_412_merged" });
  });

  it("reports duplicate source events, as a replayed duplicate delivery would produce", async () => {
    const fixture = clone(await loadOutage());
    const copy = clone(fixture.events[0]!);
    copy.id = "evt_pr_412_merged_again";
    fixture.events.splice(1, 0, copy);

    const result = validateFixture(fixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toEqual(["events.1.sourceId"]);
  });

  it("reports events from another workspace", async () => {
    const fixture = clone(await loadOutage());
    fixture.events[2]!.workspaceId = "ws_other";

    const result = validateFixture(fixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toEqual(["events.2.workspaceId"]);
  });

  it("reports events not marked as synthetic", async () => {
    const fixture = clone(await loadOutage());
    delete fixture.events[3]!.provenance.fixture;

    const result = validateFixture(fixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toEqual(["events.3.provenance.fixture"]);
  });

  it("reports events out of timeline order", async () => {
    const fixture = clone(await loadOutage());
    fixture.events.reverse();

    const result = validateFixture(fixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(7);
  });

  it("reports schema errors with their path", () => {
    const result = validateFixture({ name: "Bad Name", description: "", workspaceId: "ws_demo", events: [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path).sort()).toEqual(["description", "events", "name"]);
  });
});

describe("timeline ordering", () => {
  it("restores fixture order from any permutation", async () => {
    const { events } = await loadOutage();
    const shuffled = [events[5], events[0], events[7], events[2], events[1], events[6], events[4], events[3]];

    expect(sortTimeline(shuffled as NormalizedEvent[]).map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it("breaks timestamp ties by source, then sourceId, then id", async () => {
    const { events } = await loadOutage();
    const a = { ...clone(events[0]!), source: "github" as const, sourceId: "b" };
    const b = { ...clone(events[0]!), source: "replay" as const, sourceId: "a" };
    const c = { ...clone(events[0]!), source: "replay" as const, sourceId: "a", id: "evt_z" };

    expect(compareEvents(a, b)).toBeLessThan(0);
    expect(compareEvents(b, c)).toBeLessThan(0);
    expect(compareEvents(c, c)).toBe(0);
    expect(sortTimeline([c, b, a]).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });
});
