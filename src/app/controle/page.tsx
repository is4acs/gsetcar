import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { Badge, Empty, Shell } from "@/components/ui";
import { listVehicles } from "@/lib/queries";
import { fmtDate, fmtKm } from "@/lib/format";
import { doneMonths, vehiclePlanning } from "@/lib/planning";

export default async function ChooseVehicle() {
  const user = await requirePermission("inspection.create");
  const list = await listVehicles(user, { activeOnly: true });
  const done = await doneMonths(list.map((v) => v.id));
  // Les véhicules à contrôler maintenant en premier (semaine prévue atteinte), ceux déjà faits ce mois en dernier.
  const rank = (p: ReturnType<typeof vehiclePlanning>) => (p.current.due || p.lateMonths.length ? 0 : p.current.status === "fait" ? 2 : 1);
  const vehicles = list.map((v) => ({ ...v, plan: vehiclePlanning(v.control_week, done.get(v.id) ?? new Set()) })).sort((a, b) => rank(a.plan) - rank(b.plan) || (a.control_week ?? 9) - (b.control_week ?? 9) || a.plate.localeCompare(b.plate));
  return (
    <Shell user={user} title="Quel véhicule ?" back={{ href: "/", label: "Accueil" }}>
      {vehicles.length === 0 && <Empty>Aucun véhicule actif dans votre périmètre.</Empty>}
      <div className="grid gap-3">
        {vehicles.map((v) => (
          <Link key={v.id} href={`/controle/${v.id}`} className="card flex items-center justify-between gap-3 active:bg-slate-50">
            <div>
              <div className="font-mono text-xl font-bold tracking-wide">{v.plate}</div>
              <div className="text-slate-700">{v.label}</div>
              <div className="muted">{v.last_inspection_at ? `Dernier contrôle : ${fmtDate(v.last_inspection_at)} · ${fmtKm(v.last_km)}` : "Jamais contrôlé dans l'application"}</div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Badge tone={v.plan.current.tone}>{v.plan.current.label}</Badge>
              {v.plan.lateMonths.length > 0 && <Badge tone="red">{v.plan.lateMonths.length} mois en retard</Badge>}
              {v.immobilized && <Badge tone="red">Immobilisé</Badge>}
            </div>
          </Link>
        ))}
      </div>
    </Shell>
  );
}
