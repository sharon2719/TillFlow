import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";

describe("health endpoints", () => {
  const app = createApp();

  it("GET /health returns 200 ok (liveness)", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /ready returns 200 ready (readiness)", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready" });
  });

  it("GET / identifies the service", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("pos");
  });
});
