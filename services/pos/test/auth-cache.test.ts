import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { Cache } from "../src/cache.js";
import type { Queryable } from "../src/db.js";

const MIGRATION_SQL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "001_tenant_setup.sql"),
  "utf8",
);

function createTestDb(): Queryable {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.none(MIGRATION_SQL);
  const { Pool } = mem.adapters.createPg();
  return new Pool();
}

/** An in-memory Cache double, with a spy on every method so tests can assert call counts. */
function createSpyCache(): Cache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

async function createTenantAndKey(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await request(app).post("/tenants").send({ name: "Cache Test Duka", ownerName: "Owner" });
  return res.body.apiKey as string;
}

describe("auth cache (read-through, DB is always the source of truth)", () => {
  let db: Queryable;
  let cache: ReturnType<typeof createSpyCache>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    cache = createSpyCache();
    app = createApp(db, cache);
  });

  it("queries the DB and populates the cache on the first request with a given key", async () => {
    const apiKey = await createTenantAndKey(app);
    const dbQuerySpy = vi.spyOn(db, "query");

    const res = await request(app).get("/tills").set("Authorization", `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    // requireAuth's own DB lookup ran (there may be other queries from other middleware, so
    // just assert it was called, not an exact count).
    expect(dbQuerySpy).toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it("serves the second request for the same key from cache, without a second DB auth lookup", async () => {
    const apiKey = await createTenantAndKey(app);

    await request(app).get("/tills").set("Authorization", `Bearer ${apiKey}`);
    const dbQuerySpy = vi.spyOn(db, "query");

    const res = await request(app).get("/tills").set("Authorization", `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(cache.get).toHaveBeenCalled();
    // No new api_keys lookup happened for this second request - the auth query specifically
    // never ran, only whatever /tills itself queries (the tills table, not api_keys).
    const authQueryRan = dbQuerySpy.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("pos.api_keys"));
    expect(authQueryRan).toBe(false);
  });

  it("falls back to the DB when the cache returns a corrupt value instead of rejecting the request", async () => {
    const apiKey = await createTenantAndKey(app);
    await request(app).get("/tills").set("Authorization", `Bearer ${apiKey}`); // populate the cache
    for (const key of cache.store.keys()) {
      cache.store.set(key, "not valid json");
    }

    const res = await request(app).get("/tills").set("Authorization", `Bearer ${apiKey}`);

    expect(res.status).toBe(200); // corrupt cache entry did not turn into a 401/500
  });

  it("falls back to the DB when cache.get/set throw (a Redis outage), instead of failing the request", async () => {
    const apiKey = await createTenantAndKey(app);
    const throwingCache: Cache = {
      get: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      set: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const appWithThrowingCache = createApp(db, throwingCache);

    // requireAuth guards its own cache.get/set calls (defense in depth on top of
    // createRedisCache's own try/catch) - even a Cache implementation that breaks its "never
    // throws" contract can only degrade auth to a DB lookup, never take the request down.
    const res = await request(appWithThrowingCache).get("/tills").set("Authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
  });
});
