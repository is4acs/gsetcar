import { cookies } from "next/headers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { appUrl, authSecret, createSession } from "@/lib/auth";
import { audit, q1 } from "@/lib/db";

const GOOGLE_KEYS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export async function GET(req: Request) {
  const base = appUrl(req);
  const fail = (code: string) => Response.redirect(`${base}/login?erreur=${code}`, 302);
  try {
    const params = new URL(req.url).searchParams;
    const jar = await cookies();
    const pendingToken = jar.get("gset_oauth")?.value;
    jar.delete({ name: "gset_oauth", path: "/api/auth" });
    if (!pendingToken || !params.get("code")) return fail("session");
    const pending = (await jwtVerify(pendingToken, authSecret(), { algorithms: ["HS256"] })).payload as { state: string; nonce: string; verifier: string };
    if (params.get("state") !== pending.state) return fail("session");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: params.get("code")!, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${base}/api/auth/callback`, grant_type: "authorization_code", code_verifier: pending.verifier,
      }),
    });
    if (!tokenRes.ok) return fail("google");
    const { id_token } = (await tokenRes.json()) as { id_token?: string };
    if (!id_token) return fail("google");
    const { payload } = await jwtVerify(id_token, GOOGLE_KEYS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"], audience: process.env.GOOGLE_CLIENT_ID,
    });
    if (payload.nonce !== pending.nonce || payload.email_verified !== true || typeof payload.email !== "string") return fail("google");

    // Autorisation : liste explicite d'utilisateurs actifs, pas seulement le domaine de l'adresse.
    const user = await q1<{ id: string }>("select id from users where email = $1 and active", [payload.email.toLowerCase()]);
    if (!user) {
      await audit(undefined, null, "connexion_refusee", "user", null, { email: payload.email.toLowerCase() });
      return fail("non_autorise");
    }
    await createSession(user.id);
    await audit(undefined, user.id, "connexion", "user", user.id);
    return Response.redirect(`${base}/`, 302);
  } catch (e) {
    console.error(e);
    return fail("google");
  }
}
