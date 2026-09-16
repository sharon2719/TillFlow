#!/usr/bin/env node
/** Same minimal migration runner as services/pos/src/migrate.ts. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPool } from "./db.js";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

async function main() {
  const pool = createPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS commission_schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ filename: string }>("SELECT filename FROM commission_schema_migrations")).rows.map(
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
      await client.query("INSERT INTO commission_schema_migrations (filename) VALUES ($1)", [file]);
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
