import { Redis } from "ioredis";

import { logger } from "./logger.js";

/**
 * A read-through cache for the API-key lookup in auth.ts - the one DB round trip every
 * single authenticated request makes (docs/capacity-report.md's working hypothesis for
 * pos's Run-1 SLO miss). Every method is designed to never throw and never hang the
 * request past a short timeout: a Redis outage must degrade auth to a plain DB lookup, not
 * break it.
 */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export function createNoopCache(): Cache {
  return {
    async get() {
      return null;
    },
    async set() {
      // no-op
    },
  };
}

export function createRedisCache(url: string): Cache {
  const client = new Redis(url, {
    lazyConnect: true,
    // A cache is only worth using if it's faster than the DB round trip it replaces - fail
    // fast and fall back rather than let a slow/unreachable Redis make auth slower than not
    // having a cache at all.
    commandTimeout: 250,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  // ioredis emits 'error' on the client for every failed connection attempt; without a
  // listener, that's an unhandled 'error' event that crashes the process. Logging it here is
  // what makes "Redis is down" a degraded cache, not a crashed pos service.
  client.on("error", (err) => {
    logger.warn({ err }, "redis cache connection error - auth will fall back to the database");
  });

  return {
    async get(key) {
      try {
        return await client.get(key);
      } catch (err) {
        logger.warn({ err, key }, "redis get failed - treating as a cache miss");
        return null;
      }
    },
    async set(key, value, ttlSeconds) {
      try {
        await client.set(key, value, "EX", ttlSeconds);
      } catch (err) {
        logger.warn({ err, key }, "redis set failed - continuing without caching this key");
      }
    },
  };
}
