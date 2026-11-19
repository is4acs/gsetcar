import { kickDriveJobs } from "@/lib/kick";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Flash, Shell } from "@/components/ui";
import { q1 } from "@/lib/db";
import { LocalDraftsNotice } from "./controle/drafts-notice";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  await kickDriveJobs();
  const sp = await searchParams;
  const pending = can(user.role, "jobs.manage") ? await q1<{ n: number }>("select count(*)::int as n from drive_jobs where status <> 'termine'") : null;
  return (
    <Shell user={user} title={`Bonjour ${user.name.split(" ")[0]}`}>
      <Flash params={sp.refus ? { err: "Cette page n'est pas accessible avec votre rôle." } : sp} />
      <div className="grid gap-4">
        {can(user.role, "inspection.create") && (
          <Link href="/controle" className="btn-primary min-h-24 flex-col text-xl">
            <span>Contrôler un véhicule</span>
            <span className="text-sm font-normal opacity-90">Kilométrage, points de contrôle, photos</span>
          </Link>
        )}
        <Link href="/reparations" className="btn-secondary min-h-24 flex-col text-xl">
          <span>Mettre à jour une réparation</span>
          <span className="muted font-normal">Devis, avancement, facture</span>
        </Link>
        {can(user.role, "dashboard.view") && (
          <Link href="/direction" className="btn-secondary min-h-16 text-lg">Tableau de bord direction</Link>
        )}
      </div>
      {pending && pending.n > 0 && (
        <Link href="/envois" className="card block border-amber-300 bg-amber-50 text-sm font-medium text-amber-900">
          {pending.n} document(s) en attente de dépôt sur Drive — voir les envois
        </Link>
      )}
      <LocalDraftsNotice />
    </Shell>
  );
}
