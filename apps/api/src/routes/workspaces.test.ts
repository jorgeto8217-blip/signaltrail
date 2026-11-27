import { afterEach, describe, expect, it } from "vitest";
import { people, setup } from "../test-support.js";

let ctx = setup();
afterEach(async () => {
  await ctx.app.close();
  ctx = setup();
});

describe("authentication", () => {
  it.each([
    ["no header", undefined],
    ["unknown token", "Bearer stk_not_a_real_token"],
    ["wrong scheme", `Basic ${people.olivia.token}`],
  ])("returns 401 for %s", async (_label, authorization) => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: authorization === undefined ? {} : { authorization },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });
});

describe("workspaces", () => {
  it("makes the creator the owner and lists only the caller's workspaces", async () => {
    const { acme, globex } = await ctx.twoWorkspaces();

    const olivia = (await ctx.call("olivia", "GET", "/v1/workspaces")).json().data;
    expect(olivia).toEqual([expect.objectContaining({ id: acme, name: "Acme", role: "owner" })]);

    const gabe = (await ctx.call("gabe", "GET", "/v1/workspaces")).json().data;
    expect(gabe.map((w: { id: string }) => w.id)).toEqual([globex]);

    expect(acme).toMatch(/^ws_[a-z2-7]{20}$/);
  });

  it("validates the workspace name", async () => {
    for (const payload of [{}, { name: "  " }, { name: "x".repeat(81) }, { name: "ok", extra: true }]) {
      const res = await ctx.call("olivia", "POST", "/v1/workspaces", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_request");
    }
  });

  it("returns the caller's role on a workspace they belong to", async () => {
    const { acme } = await ctx.twoWorkspaces();
    const res = await ctx.call("vera", "GET", `/v1/workspaces/${acme}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: acme, role: "viewer" });
  });

  it("hides other tenants' workspaces behind the same 404 as unknown ones", async () => {
    const { globex } = await ctx.twoWorkspaces();
    const foreign = await ctx.call("olivia", "GET", `/v1/workspaces/${globex}`);
    const unknown = await ctx.call("olivia", "GET", "/v1/workspaces/ws_doesnotexist");
    const malformed = await ctx.call("olivia", "GET", "/v1/workspaces/not-an-id");
    for (const res of [foreign, unknown, malformed]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(unknown.json());
    }
  });
});

describe("members", () => {
  it("lists members (owners first) to any member", async () => {
    const { acme } = await ctx.twoWorkspaces();
    const res = await ctx.call("vera", "GET", `/v1/workspaces/${acme}/members`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      [people.olivia.email, "owner"],
      [people.marco.email, "maintainer"],
      [people.vera.email, "viewer"],
    ]);
  });

  it("lets only owners add, change and remove members", async () => {
    const { acme } = await ctx.twoWorkspaces();
    for (const who of ["marco", "vera"] as const) {
      const add = await ctx.call(who, "POST", `/v1/workspaces/${acme}/members`, {
        email: people.gabe.email,
        role: "viewer",
      });
      expect(add.statusCode).toBe(403);
      const change = await ctx.call(who, "PATCH", `/v1/workspaces/${acme}/members/${people.vera.id}`, {
        role: "owner",
      });
      expect(change.statusCode).toBe(403);
      const remove = await ctx.call(who, "DELETE", `/v1/workspaces/${acme}/members/${people.vera.id}`);
      expect(remove.statusCode).toBe(403);
    }
    expect((await ctx.store.findMembership(acme, people.vera.id))?.role).toBe("viewer");
  });

  it("adds a member by email (case-insensitive) once", async () => {
    const { acme } = await ctx.twoWorkspaces();
    const first = await ctx.call("olivia", "POST", `/v1/workspaces/${acme}/members`, {
      email: "GABE@example.test",
      role: "viewer",
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({ userId: people.gabe.id, role: "viewer" });

    const again = await ctx.call("olivia", "POST", `/v1/workspaces/${acme}/members`, {
      email: people.gabe.email,
      role: "owner",
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("already_member");

    const unknown = await ctx.call("olivia", "POST", `/v1/workspaces/${acme}/members`, {
      email: "nobody@example.test",
      role: "viewer",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("user_not_found");
  });

  it("applies a role change on the next request", async () => {
    const { acme } = await ctx.twoWorkspaces();
    const payload = { owner: "acme-demo", name: "web" };
    expect((await ctx.call("vera", "POST", `/v1/workspaces/${acme}/repositories`, payload)).statusCode).toBe(403);

    const change = await ctx.call("olivia", "PATCH", `/v1/workspaces/${acme}/members/${people.vera.id}`, {
      role: "maintainer",
    });
    expect(change.statusCode).toBe(200);
    expect(change.json().data.role).toBe("maintainer");
    expect((await ctx.call("vera", "POST", `/v1/workspaces/${acme}/repositories`, payload)).statusCode).toBe(201);
  });

  it("never leaves a workspace without an owner", async () => {
    const { acme } = await ctx.twoWorkspaces();
    const demote = await ctx.call("olivia", "PATCH", `/v1/workspaces/${acme}/members/${people.olivia.id}`, {
      role: "viewer",
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe("last_owner");
    const leave = await ctx.call("olivia", "DELETE", `/v1/workspaces/${acme}/members/${people.olivia.id}`);
    expect(leave.statusCode).toBe(409);

    await ctx.call("olivia", "PATCH", `/v1/workspaces/${acme}/members/${people.marco.id}`, { role: "owner" });
    const leaveNow = await ctx.call("olivia", "DELETE", `/v1/workspaces/${acme}/members/${people.olivia.id}`);
    expect(leaveNow.statusCode).toBe(204);
    expect((await ctx.call("olivia", "GET", `/v1/workspaces/${acme}`)).statusCode).toBe(404);
  });

  it("returns 404 for members of other workspaces and unknown users", async () => {
    const { acme } = await ctx.twoWorkspaces();
    for (const userId of [people.gabe.id, "usr_unknown", "bad id"]) {
      const res = await ctx.call("olivia", "PATCH", `/v1/workspaces/${acme}/members/${encodeURIComponent(userId)}`, {
        role: "viewer",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("member_not_found");
    }
  });
});
