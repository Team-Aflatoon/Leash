import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// bigint columns hold cents well inside 2^53; parse them as numbers.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint out of range: ${v}`);
  return n;
});

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string, max = 20): Db {
  return new pg.Pool({ connectionString: url, max, ssl: /sslmode=require|render\.com/.test(url) ? { rejectUnauthorized: false } : undefined });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate(db: Db): Promise<void> {
  await withTx(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(727274)");
    await tx.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await tx.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      await tx.query(readFileSync(join(MIGRATIONS, f), "utf8"));
      await tx.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
    }
  });
}
