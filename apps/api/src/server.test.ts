import { afterAll, describe, expect, it } from "vitest";
import { setup } from "./test-support.js";

describe("server", () => {
  const { app, call } = setup();

  afterAll(async () => {
    await app.close();
  });

  it("reports the API as up without a token", async () => {
    const res = await call(null, "GET", "/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "signaltrail-api" });
  });

  it("answers unknown routes with the error envelope", async () => {
    const res = await call(null, "GET", "/nope");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "Route not found." } });
  });

  it("rejects malformed JSON with a 400 envelope, not a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: "Bearer stk_test_olivia", "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });
});
