import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { Badge, Empty, Shell } from "@/components/ui";
import { listVehicles } from "@/lib/queries";
import { fmtDate, fmtKm } from "@/lib/format";
import { SUMMARY_LABELS } from "@/lib/checklist";
import { SUMMARY_TONES } from "@/lib/labels";

export default async function ChooseVehicle() {
  const user = await requirePermission("inspection.create");
  const vehicles = await listVehicles(user, { activeOnly: true });
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
              {v.immobilized && <Badge tone="red">Immobilisé</Badge>}
              {v.last_summary && <Badge tone={SUMMARY_TONES[v.last_summary]}>{SUMMARY_LABELS[v.last_summary].split(" :")[0]}</Badge>}
            </div>
          </Link>
        ))}
      </div>
    </Shell>
  );
}
