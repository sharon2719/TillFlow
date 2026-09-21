import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import type { Queryable } from "../src/db.js";

function createTestDb(): Queryable {
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}

describe("health endpoints", () => {
  const app = createApp(createTestDb());

  it("GET /health returns 200 ok (liveness) - never touches the DB", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /ready returns 200 ready when the DB round trip succeeds (readiness)", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready" });
  });

  it("GET /ready returns 503 when the DB round trip fails - the real gap docs/recovery-drills.md's Incident 1 found", async () => {
    const brokenDb: Queryable = {
      async query() {
        throw new Error("password authentication failed for user \"tillflow_admin\"");
      },
    };
    const appWithBrokenDb = createApp(brokenDb);

    const res = await request(appWithBrokenDb).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not ready");
  });

  it("GET / identifies the service", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("pos");
  });
});
