import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { q, q1 } from "./db";
import { can, type Permission, type Role } from "./permissions";

export const SESSION_COOKIE = "gset_session";
const SESSION_DAYS = 30;

export type User = { id: string; email: string; name: string; role: Role };

export function authSecret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET doit être défini (32 caractères minimum).");
  return new TextEncoder().encode(s);
}

export const isProd = () => process.env.NODE_ENV === "production";
/** Connexion de développement : jamais en production Vercel, uniquement si activée explicitement. */
export const devLoginEnabled = () => process.env.AUTH_DEV_LOGIN === "true" && process.env.VERCEL_ENV !== "production";

export async function createSession(userId: string) {
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`).sign(authSecret());
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: isProd(), sameSite: "lax", path: "/", maxAge: SESSION_DAYS * 86400 });
}

export async function destroySession() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Utilisateur courant, relu en base à chaque requête : un compte désactivé ou un rôle modifié s'applique immédiatement. */
export const getUser = cache(async (): Promise<User | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  let sub: string | undefined;
  try {
    sub = (await jwtVerify(token, authSecret(), { algorithms: ["HS256"] })).payload.sub;
  } catch {
    return null;
  }
  if (!sub) return null;
  return q1<User>("select id, email, name, role from users where id = $1 and active", [sub]);
});

export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/** Pour les pages : redirige vers l'accueil si le rôle ne suffit pas. */
export async function requirePermission(permission: Permission): Promise<User> {
  const user = await requireUser();
  if (!can(user.role, permission)) redirect("/?refus=1");
  return user;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

/** Pour les API et actions serveur : lève une erreur au lieu de rediriger. */
export async function apiUser(permission?: Permission): Promise<User> {
  const user = await getUser();
  if (!user) throw new ApiError(401, "Connexion requise.");
  if (permission && !can(user.role, permission)) throw new ApiError(403, "Action non autorisée pour votre rôle.");
  return user;
}

/**
 * Périmètre véhicules : null = tous. Un technicien ayant des lignes dans user_vehicle_scope
 * est limité à ces véhicules ; les autres rôles voient tout le parc.
 */
export const vehicleScope = cache(async (userId: string, role: Role): Promise<string[] | null> => {
  if (role !== "technicien") return null;
  const rows = await q<{ vehicle_id: string }>("select vehicle_id from user_vehicle_scope where user_id = $1", [userId]);
  return rows.length ? rows.map((r) => r.vehicle_id) : null;
});

export async function canAccessVehicle(user: User, vehicleId: string): Promise<boolean> {
  const scope = await vehicleScope(user.id, user.role);
  return scope === null || scope.includes(vehicleId);
}

export async function assertVehicleAccess(user: User, vehicleId: string) {
  if (!(await canAccessVehicle(user, vehicleId))) throw new ApiError(404, "Véhicule introuvable.");
}

/** Refuse les requêtes d'écriture venant d'un autre site (en complément du cookie SameSite=Lax). */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return; // navigateurs : toujours présent sur les POST inter-sites
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (new URL(origin).host !== host) throw new ApiError(403, "Origine refusée.");
}

export function apiHandler<A extends unknown[]>(fn: (req: Request, ...args: A) => Promise<Response>) {
  return async (req: Request, ...args: A): Promise<Response> => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      return await fn(req, ...args);
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.message, details: e.details }, { status: e.status });
      console.error(e);
      return Response.json({ error: "Erreur interne. Réessayez." }, { status: 500 });
    }
  };
}

export function appUrl(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}
