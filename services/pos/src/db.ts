import pg from "pg";

/**
 * Minimal interface both the real `pg.Pool` and pg-mem's adapter satisfy - routes depend on
 * this, not on `pg.Pool` directly, so tests can inject an in-memory database instead of
 * needing a real Postgres to run against.
 */
export interface Queryable {
  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export function createPool(): pg.Pool {
  return new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // RDS requires TLS by default; not pinning the RDS CA bundle yet (see
    // docs/production-readiness.md), so this doesn't verify the server certificate.
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
}
