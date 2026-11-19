import { cookies } from "next/headers";
import { SignJWT } from "jose";
import { randomBytes } from "node:crypto";
import { ApiError, apiHandler, apiUser, appUrl, authSecret, isProd } from "@/lib/auth";
import { DRIVE_SCOPE, driveOAuthClient } from "@/lib/drive";

// Connexion du compte Google GSET autorisé sur le dossier « VEHICULES GUYANE » (dossier dans « Mon Drive »).
// Réservé à l'administrateur. Le jeton obtenu est stocké chiffré en base, jamais affiché.
export const GET = apiHandler(async (req) => {
  const user = await apiUser("admin.manage");
  const { id } = driveOAuthClient();
  if (!id) throw new ApiError(500, "Client OAuth Google non configuré (GOOGLE_CLIENT_ID).");
  const state = randomBytes(24).toString("base64url");
  const pending = await new SignJWT({ state, uid: user.id }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("10m").sign(authSecret());
  (await cookies()).set("gset_drive_oauth", pending, { httpOnly: true, secure: isProd(), sameSite: "lax", path: "/api/drive/oauth", maxAge: 600 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: id, redirect_uri: `${appUrl(req)}/api/drive/oauth/callback`, response_type: "code", scope: `${DRIVE_SCOPE} openid email`,
    access_type: "offline", prompt: "consent select_account", state,
  }).toString();
  return Response.redirect(url.toString(), 302);
});
