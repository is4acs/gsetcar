import { redirect } from "next/navigation";
import { devLoginEnabled, getUser } from "@/lib/auth";
import { q } from "@/lib/db";
import { ROLE_LABELS, type Role } from "@/lib/permissions";

const ERRORS: Record<string, string> = {
  non_autorise: "Ce compte Google n'est pas autorisé. Demandez à un administrateur de vous ajouter.",
  session: "La connexion a expiré. Réessayez.",
  google: "La connexion Google a échoué. Réessayez.",
  base: "Votre compte Google est reconnu, mais la base de données est inaccessible. Prévenez l'administrateur.",
  configuration: "La connexion Google n'est pas encore configurée sur ce site.",
};

export default async function Login({ searchParams }: { searchParams: Promise<{ erreur?: string }> }) {
  if (await getUser()) redirect("/");
  const { erreur } = await searchParams;
  const devUsers = devLoginEnabled() ? await q<{ email: string; name: string; role: Role }>("select email, name, role from users where active order by role, name") : [];
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 px-5">
      <div>
        <h1 className="text-3xl font-bold text-blue-800">Parc auto GSET</h1>
        <p className="muted mt-1">Contrôles et réparations des véhicules GSET Caraïbes.</p>
      </div>
      {erreur && <p className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">{ERRORS[erreur] ?? "Connexion impossible."}</p>}
      <a href="/api/auth/google" className="btn-primary min-h-14 text-lg">Se connecter avec Google</a>
      {devLoginEnabled() && (
        <div className="card space-y-2 border-amber-300 bg-amber-50">
          <p className="text-sm font-semibold text-amber-900">Mode développement — connexion sans Google</p>
          {devUsers.map((u) => (
            <form key={u.email} action="/api/auth/dev" method="post">
              <input type="hidden" name="email" value={u.email} />
              <button className="btn-secondary btn-sm w-full justify-between"><span>{u.name}</span><span className="muted">{ROLE_LABELS[u.role]}</span></button>
            </form>
          ))}
        </div>
      )}
    </main>
  );
}
