import Link from "next/link";
import type { User } from "@/lib/auth";
import { can, ROLE_LABELS } from "@/lib/permissions";

export type Tone = "gray" | "green" | "amber" | "red" | "blue";
const TONES: Record<Tone, string> = {
  gray: "bg-slate-100 text-slate-700", green: "bg-emerald-100 text-emerald-800", amber: "bg-amber-100 text-amber-900",
  red: "bg-red-100 text-red-800", blue: "bg-blue-100 text-blue-800",
};
export function Badge({ tone = "gray", children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}

export function Shell({ user, title, back, wide, children }: { user: User; title: string; back?: { href: string; label: string }; wide?: boolean; children: React.ReactNode }) {
  const links: [string, string, boolean][] = [
    ["/", "Accueil", true],
    ["/direction", "Tableau de bord", can(user.role, "dashboard.view")],
    ["/planning", "Planning", can(user.role, "dashboard.view")],
    ["/reparations", "Réparations", true],
    ["/envois", "Envois Drive", can(user.role, "jobs.manage")],
    ["/admin", "Administration", can(user.role, "admin.manage")],
  ];
  return (
    <div className="min-h-screen">
      <header className="bg-blue-800 text-white">
        <div className={`mx-auto flex ${wide ? "max-w-6xl" : "max-w-2xl"} flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3`}>
          <Link href="/" className="text-lg font-bold">Parc auto GSET</Link>
          <nav className="flex flex-1 flex-wrap gap-x-4 gap-y-1 text-sm">
            {links.filter((l) => l[2]).slice(1).map(([href, label]) => <Link key={href} href={href} className="underline-offset-4 hover:underline">{label}</Link>)}
          </nav>
          <form action="/api/auth/logout" method="post" className="flex items-center gap-2 text-xs">
            <span className="hidden sm:inline">{user.name} · {ROLE_LABELS[user.role]}</span>
            <button className="rounded-lg border border-white/40 px-2 py-1 hover:bg-white/10">Déconnexion</button>
          </form>
        </div>
      </header>
      <main className={`mx-auto ${wide ? "max-w-6xl" : "max-w-2xl"} space-y-4 px-4 py-5`}>
        {back && <Link href={back.href} className="text-sm font-medium text-blue-700">← {back.label}</Link>}
        <h1 className="text-2xl font-bold">{title}</h1>
        {children}
      </main>
    </div>
  );
}

/** Message de retour d'une action serveur (?ok=… ou ?err=…). */
export function Flash({ params }: { params: Record<string, string | string[] | undefined> }) {
  const ok = typeof params.ok === "string" ? params.ok : null;
  const err = typeof params.err === "string" ? params.err : null;
  if (!ok && !err) return null;
  return (
    <div role="status" className={`rounded-xl border px-4 py-3 text-sm font-medium ${err ? "border-red-300 bg-red-50 text-red-800" : "border-emerald-300 bg-emerald-50 text-emerald-800"}`}>
      {err ?? (ok === "1" ? "Enregistré." : ok)}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="muted mt-1 block">{hint}</span>}
    </label>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="muted py-2">{children}</p>;
}
