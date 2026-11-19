import { appUrl, createSession, devLoginEnabled } from "@/lib/auth";
import { q1 } from "@/lib/db";

// Connexion de développement sans Google. Désactivée sauf AUTH_DEV_LOGIN=true hors production.
export async function POST(req: Request) {
  if (!devLoginEnabled()) return new Response("Not found", { status: 404 });
  const email = String((await req.formData()).get("email") ?? "").toLowerCase();
  const user = await q1<{ id: string }>("select id from users where email = $1 and active", [email]);
  if (!user) return Response.redirect(`${appUrl(req)}/login?erreur=non_autorise`, 303);
  await createSession(user.id);
  return Response.redirect(`${appUrl(req)}/`, 303);
}
