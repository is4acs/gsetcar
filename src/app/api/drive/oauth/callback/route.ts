import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import { apiHandler, apiUser, appUrl, authSecret } from "@/lib/auth";
import { audit } from "@/lib/db";
import { DRIVE_SCOPE, DRIVE_SECRET, driveOAuthClient, resetDriveToken } from "@/lib/drive";
import { setSecret } from "@/lib/secrets";

export const GET = apiHandler(async (req) => {
  const user = await apiUser("admin.manage");
  const base = appUrl(req);
  const done = (kind: "ok" | "err", msg: string) => Response.redirect(`${base}/admin?${kind}=${encodeURIComponent(msg)}`, 302);
  const params = new URL(req.url).searchParams;
  const jar = await cookies();
  const pendingToken = jar.get("gset_drive_oauth")?.value;
  jar.delete({ name: "gset_drive_oauth", path: "/api/drive/oauth" });
  if (!pendingToken || !params.get("code")) return done("err", "Connexion Drive annulée ou expirée.");
  const pending = (await jwtVerify(pendingToken, authSecret(), { algorithms: ["HS256"] })).payload as { state: string; uid: string };
  if (pending.state !== params.get("state") || pending.uid !== user.id) return done("err", "Connexion Drive invalide. Réessayez.");

  const { id, secret } = driveOAuthClient();
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ code: params.get("code")!, client_id: id!, client_secret: secret!, redirect_uri: `${base}/api/drive/oauth/callback`, grant_type: "authorization_code" }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; scope?: string };
  if (!tokenRes.ok || !token.access_token) return done("err", "Google a refusé la connexion Drive.");
  if (!token.scope?.split(" ").includes(DRIVE_SCOPE)) return done("err", "L'accès à Google Drive n'a pas été accordé : cochez l'autorisation Drive lors de la connexion.");
  if (!token.refresh_token) return done("err", "Google n'a pas fourni d'accès durable. Retirez l'accès de l'application dans le compte Google puis recommencez.");
  const about = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)", { headers: { authorization: `Bearer ${token.access_token}` } });
  const account = about.ok ? ((await about.json()) as { user?: { emailAddress?: string; displayName?: string } }).user : undefined;
  await setSecret(DRIVE_SECRET, token.refresh_token, { email: account?.emailAddress ?? null, name: account?.displayName ?? null }, user.id);
  resetDriveToken();
  await audit(undefined, user.id, "drive_compte_connecte", "settings", DRIVE_SECRET, { compte: account?.emailAddress ?? null });
  return done("ok", `Compte Google Drive connecté${account?.emailAddress ? ` (${account.emailAddress})` : ""}. Vérifiez maintenant chaque dossier par un dépôt pilote.`);
});
