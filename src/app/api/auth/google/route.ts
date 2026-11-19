import { cookies } from "next/headers";
import { SignJWT } from "jose";
import { randomBytes, createHash } from "node:crypto";
import { appUrl, authSecret, isProd } from "@/lib/auth";

const b64 = (b: Buffer) => b.toString("base64url");

// Démarre la connexion Google (OpenID Connect, flux « code » avec PKCE, state et nonce).
export async function GET(req: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return Response.redirect(`${appUrl(req)}/login?erreur=configuration`, 302);
  const state = b64(randomBytes(24)), nonce = b64(randomBytes(24)), verifier = b64(randomBytes(32));
  const pending = await new SignJWT({ state, nonce, verifier }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("10m").sign(authSecret());
  (await cookies()).set("gset_oauth", pending, { httpOnly: true, secure: isProd(), sameSite: "lax", path: "/api/auth", maxAge: 600 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: `${appUrl(req)}/api/auth/callback`, response_type: "code", scope: "openid email profile",
    state, nonce, code_challenge: b64(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", prompt: "select_account",
  }).toString();
  return Response.redirect(url.toString(), 302);
}
