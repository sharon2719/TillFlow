import pg from "pg";

/** Same shape as services/pos/src/db.ts's Queryable - kept per-service rather than shared,
 * since it's a two-line interface and not worth a cross-service dependency on its own. */
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
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
}
