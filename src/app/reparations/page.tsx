import Link from "next/link";
import { requireUser, vehicleScope } from "@/lib/auth";
import { q } from "@/lib/db";
import { Badge, Empty, Shell } from "@/components/ui";
import { REPAIR_STATUS_LABELS, type RepairStatus } from "@/lib/repair-status";
import { REPAIR_TONES } from "@/lib/labels";
import { fmtDate } from "@/lib/format";

export default async function Repairs({ searchParams }: { searchParams: Promise<{ closes?: string }> }) {
  const user = await requireUser();
  const closed = (await searchParams).closes === "1";
  const scope = await vehicleScope(user.id, user.role);
  const rows = await q<{ id: string; title: string; status: RepairStatus; urgent: boolean; plate: string; label: string; garage: string | null; planned_on: string | null; updated_at: Date }>(
    `select r.id, r.title, r.status, r.urgent, r.garage, r.planned_on, r.updated_at, v.plate, v.label from repairs r join vehicles v on v.id = r.vehicle_id
     where ($1::uuid[] is null or v.id = any($1)) and (r.status in ('termine','refuse','annule')) = $2
     order by r.urgent desc, r.updated_at desc limit 200`, [scope, closed]);
  return (
    <Shell user={user} title={closed ? "Réparations closes" : "Réparations en cours"} back={{ href: "/", label: "Accueil" }}>
      <div className="flex gap-2 text-sm">
        <Link href="/reparations" className={`btn-sm btn ${!closed ? "bg-slate-800 text-white" : "border border-slate-300 bg-white"}`}>En cours</Link>
        <Link href="/reparations?closes=1" className={`btn-sm btn ${closed ? "bg-slate-800 text-white" : "border border-slate-300 bg-white"}`}>Closes</Link>
      </div>
      {rows.length === 0 && <Empty>Aucune réparation {closed ? "close" : "en cours"}.</Empty>}
      <div className="grid gap-3">
        {rows.map((r) => (
          <Link key={r.id} href={`/reparations/${r.id}`} className="card block active:bg-slate-50">
            <div className="flex items-start justify-between gap-2">
              <span className="font-mono text-lg font-bold">{r.plate}</span>
              <span className="flex gap-1">{r.urgent && <Badge tone="red">Urgent</Badge>}<Badge tone={REPAIR_TONES[r.status]}>{REPAIR_STATUS_LABELS[r.status]}</Badge></span>
            </div>
            <div className="font-medium">{r.title}</div>
            <div className="muted">{[r.label, r.garage, r.planned_on && `prévu le ${fmtDate(r.planned_on)}`].filter(Boolean).join(" · ")}</div>
          </Link>
        ))}
      </div>
      <p className="muted">Pour créer une réparation sans contrôle, ouvrez la fiche du véhicule.</p>
    </Shell>
  );
}
