// Applique les migrations SQL du dossier migrations/ (une seule fois chacune, dans l'ordre).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../src/lib/db";

async function main() {
  const db = await pool().connect();
  try {
    await db.query("select pg_advisory_lock(727001)");
    await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await db.query("select name from schema_migrations")).rows.map((r) => r.name));
    const dir = join(process.cwd(), "migrations");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      await db.query("begin");
      try {
        await db.query(readFileSync(join(dir, f), "utf8"));
        await db.query("insert into schema_migrations (name) values ($1)", [f]);
        await db.query("commit");
        console.log("appliquée :", f);
      } catch (e) {
        await db.query("rollback");
        throw e;
      }
    }
    console.log("Migrations à jour.");
  } finally {
    await db.query("select pg_advisory_unlock(727001)").catch(() => {});
    db.release();
    await pool().end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
