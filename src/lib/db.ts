import { Pool, type PoolClient, type QueryResultRow } from "pg";

const globalForPg = globalThis as unknown as { __gsetPool?: Pool };

export function pool(): Pool {
  if (!globalForPg.__gsetPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL n'est pas défini.");
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    globalForPg.__gsetPool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      ssl: local || process.env.DATABASE_SSL === "disable" ? undefined : { rejectUnauthorized: process.env.DATABASE_SSL !== "no-verify" },
    });
  }
  return globalForPg.__gsetPool;
}

export type Db = Pick<PoolClient, "query">;

export async function q<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = [], db?: Db): Promise<T[]> {
  const res = await (db ?? pool()).query<T>(text, params);
  return res.rows;
}

export async function q1<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = [], db?: Db): Promise<T | null> {
  return (await q<T>(text, params, db))[0] ?? null;
}

export async function tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function audit(db: Db | undefined, userId: string | null, action: string, entity: string, entityId: string | null, details?: unknown) {
  await q("insert into audit_log (user_id, action, entity, entity_id, details) values ($1,$2,$3,$4,$5)",
    [userId, action, entity, entityId, details === undefined ? null : JSON.stringify(details)], db);
}
