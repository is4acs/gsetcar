// Secrets applicatifs stockés chiffrés en base (AES-256-GCM, clé dérivée de AUTH_SECRET).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { q, q1 } from "./db";

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET doit être défini (32 caractères minimum).");
  return Buffer.from(hkdfSync("sha256", secret, "gset-parc-auto", "app-secrets-v1", 32));
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export async function setSecret(name: string, value: string, meta: unknown, userId: string) {
  await q(`insert into app_secrets (key, ciphertext, meta, updated_by) values ($1,$2,$3,$4)
           on conflict (key) do update set ciphertext = excluded.ciphertext, meta = excluded.meta, updated_at = now(), updated_by = excluded.updated_by`,
    [name, encrypt(value), JSON.stringify(meta ?? null), userId]);
}
export async function getSecret(name: string): Promise<string | null> {
  const row = await q1<{ ciphertext: string }>("select ciphertext from app_secrets where key = $1", [name]);
  return row ? decrypt(row.ciphertext) : null;
}
export async function secretMeta<T>(name: string): Promise<(T & { updated_at: Date }) | null> {
  const row = await q1<{ meta: T; updated_at: Date }>("select meta, updated_at from app_secrets where key = $1", [name]);
  return row ? { ...row.meta, updated_at: row.updated_at } : null;
}
