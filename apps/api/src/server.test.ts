import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("GET /health", () => {
  const app = buildServer({ logger: false });

  afterAll(async () => {
    await app.close();
  });

  it("reports the API as up", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "signaltrail-api" });
  });
});
