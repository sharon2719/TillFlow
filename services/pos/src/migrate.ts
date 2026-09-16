#!/usr/bin/env node
/**
 * Minimal migration runner: applies every .sql file in migrations/ in filename order that
 * isn't already recorded in pos_schema_migrations, each inside its own transaction. No
 * rollback-on-failure across files, no down-migrations - deliberately simple for a
 * single-table-owner-per-service setup. Reconsider if this ever needs to coordinate
 * migrations across more than one service sharing this runner.
 *
 * Usage: node dist/migrate.js   (or `npm run migrate` in dev via tsx)
 * Reads the same DB_* env vars as the app itself.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPool } from "./db.js";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/migrate.js -> ../migrations ; src/migrate.ts (via tsx) -> ../migrations too
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

async function main() {
  const pool = createPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ filename: string }>("SELECT filename FROM pos_schema_migrations")).rows.map(
      (r) => r.filename,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      logger.info({ file }, "migration already applied, skipping");
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    logger.info({ file }, "applying migration");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO pos_schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      logger.info({ file }, "migration applied");
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error({ file, err }, "migration failed, rolled back");
      throw err;
    } finally {
      client.release();
    }
  }

  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, "migration run failed");
  process.exit(1);
});
