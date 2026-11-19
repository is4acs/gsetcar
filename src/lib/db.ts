import { Pool, type PoolClient, type QueryResultRow } from "pg";

const globalForPg = globalThis as unknown as { __gsetPool?: Pool };

/** Lit l'autorité de certification fournie dans DATABASE_CA_CERT : PEM, PEM avec « \n » littéraux, ou PEM encodé en base64. */
export function parseCaCert(raw: string): string {
  let pem = raw.trim().replace(/\\n/g, "\n").replace(/\r/g, "");
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) pem = Buffer.from(pem.replace(/\s+/g, ""), "base64").toString("utf8").trim();
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(pem)) throw new Error("DATABASE_CA_CERT ne contient pas de certificat PEM valide.");
  return pem + "\n";
}

type Env = Record<string, string | undefined>;
export type DbConfig = { connectionString: string; ssl: undefined | { rejectUnauthorized: boolean; ca?: string } };

/**
 * Paramètres de connexion et de vérification TLS.
 *  - base locale ou DATABASE_SSL=disable : pas de TLS ;
 *  - DATABASE_CA_CERT défini : TLS vérifié avec cette autorité (cas de Supabase, dont l'autorité n'est pas connue de Node.js) ;
 *  - DATABASE_SSL=no-verify : TLS sans vérification du serveur (secours, déconseillé) ;
 *  - sinon : TLS vérifié avec les autorités connues de Node.js.
 */
export function dbConfig(url: string, env: Env = process.env): DbConfig {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  // Les paramètres ssl* de l'URL prendraient le pas sur la configuration ci-dessous : on les retire.
  const connectionString = url.replace(/([?&])(sslmode|sslrootcert|sslcert|sslkey|uselibpqcompat)=[^&]*&?/g, "$1").replace(/[?&]$/, "");
  if (local || env.DATABASE_SSL === "disable") return { connectionString, ssl: undefined };
  if (env.DATABASE_CA_CERT?.trim()) return { connectionString, ssl: { ca: parseCaCert(env.DATABASE_CA_CERT), rejectUnauthorized: true } };
  return { connectionString, ssl: { rejectUnauthorized: env.DATABASE_SSL !== "no-verify" } };
}

export function pool(): Pool {
  if (!globalForPg.__gsetPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL n'est pas défini.");
    globalForPg.__gsetPool = new Pool({ ...dbConfig(url), max: Number(process.env.DATABASE_POOL_MAX ?? 5) });
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
