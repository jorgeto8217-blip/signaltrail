import { afterEach, describe, expect, it } from "vitest";
import { setup } from "../test-support.js";

let ctx = setup();
afterEach(async () => {
  await ctx.app.close();
  ctx = setup();
});

describe("repositories", () => {
  it("lets maintainers and owners connect repositories, but not viewers", async () => {
    const { acme } = await ctx.twoWorkspaces();
    const url = `/v1/workspaces/${acme}/repositories`;

    const marco = await ctx.call("marco", "POST", url, { owner: "acme-demo", name: "storefront-docs" });
    expect(marco.statusCode).toBe(201);
    expect(marco.json().data).toMatchObject({ fullName: "acme-demo/storefront-docs", createdById: "usr_marco" });
    expect(marco.json().data.id).toMatch(/^repo_[a-z2-7]{20}$/);

    const vera = await ctx.call("vera", "POST", url, { owner: "acme-demo", name: "other" });
    expect(vera.statusCode).toBe(403);
    expect(vera.json().error).toEqual({ code: "forbidden", message: "This action requires the maintainer role." });

    const list = (await ctx.call("vera", "GET", url)).json().data;
    expect(list.map((r: { fullName: string }) => r.fullName)).toEqual(["acme-demo/checkout", "acme-demo/storefront-docs"]);
  });

  it("checks the role before validating the body", async () => {
    const { acme } = await ctx.twoWorkspaces();
    const res = await ctx.call("vera", "POST", `/v1/workspaces/${acme}/repositories`, { owner: "" });
    expect(res.statusCode).toBe(403);
  });

  it("rejects the same repository twice, ignoring case", async () => {
    const { acme, globex } = await ctx.twoWorkspaces();
    const dup = await ctx.call("marco", "POST", `/v1/workspaces/${acme}/repositories`, {
      owner: "ACME-demo",
      name: "Checkout",
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("repository_exists");

    // Another workspace may connect the same repository independently.
    const other = await ctx.call("gabe", "POST", `/v1/workspaces/${globex}/repositories`, {
      owner: "acme-demo",
      name: "checkout",
    });
    expect(other.statusCode).toBe(201);
  });

  it.each([
    [{ owner: "-bad", name: "x" }],
    [{ owner: "bad--owner", name: "x" }],
    [{ owner: "a".repeat(40), name: "x" }],
    [{ owner: "ok", name: ".." }],
    [{ owner: "ok", name: "has space" }],
    [{ owner: "ok", name: "a".repeat(101) }],
    [{ owner: "ok" }],
    [{ owner: "ok", name: "x", secret: "nope" }],
  ])("rejects invalid input %j", async (payload) => {
    const { acme } = await ctx.twoWorkspaces();
    const res = await ctx.call("olivia", "POST", `/v1/workspaces/${acme}/repositories`, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("cannot read or delete another workspace's repository, even by its ID", async () => {
    const { acme, globex, globexRepo } = await ctx.twoWorkspaces();

    const viaOwnWorkspace = await ctx.call("olivia", "GET", `/v1/workspaces/${acme}/repositories/${globexRepo}`);
    expect(viaOwnWorkspace.statusCode).toBe(404);
    expect(viaOwnWorkspace.json().error.code).toBe("repository_not_found");

    const viaForeignWorkspace = await ctx.call("olivia", "GET", `/v1/workspaces/${globex}/repositories/${globexRepo}`);
    expect(viaForeignWorkspace.statusCode).toBe(404);
    expect(viaForeignWorkspace.json().error.code).toBe("workspace_not_found");

    const del = await ctx.call("olivia", "DELETE", `/v1/workspaces/${acme}/repositories/${globexRepo}`);
    expect(del.statusCode).toBe(404);
    expect(await ctx.store.findRepository(globex, globexRepo)).not.toBeNull();
  });

  it("lets a maintainer disconnect a repository; viewers cannot", async () => {
    const { acme, acmeRepo } = await ctx.twoWorkspaces();
    const url = `/v1/workspaces/${acme}/repositories/${acmeRepo}`;
    expect((await ctx.call("vera", "DELETE", url)).statusCode).toBe(403);
    expect((await ctx.call("marco", "DELETE", url)).statusCode).toBe(204);
    expect((await ctx.call("vera", "GET", url)).statusCode).toBe(404);
    expect((await ctx.call("marco", "DELETE", url)).statusCode).toBe(404);
  });
});
