import { notFound } from "next/navigation";
import { canAccessVehicle, requirePermission } from "@/lib/auth";
import { q1 } from "@/lib/db";
import { Shell } from "@/components/ui";
import { CHECKLIST_VERSION, checklistFor, nacelleChecklistMissing } from "@/lib/checklist";
import { fmtDate } from "@/lib/format";
import { alertContact } from "@/lib/queries";
import { doneMonths, vehiclePlanning } from "@/lib/planning";
import { Wizard } from "./wizard";

export default async function ControlPage({ params }: { params: Promise<{ vehicleId: string }> }) {
  const user = await requirePermission("inspection.create");
  const { vehicleId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(vehicleId) || !(await canAccessVehicle(user, vehicleId))) notFound();
  const v = await q1<{ id: string; plate: string; label: string; nacelle: boolean; status: string; site: string | null; assignment: string | null; control_week: number | null }>("select id, plate, label, nacelle, status, site, assignment, control_week from vehicles where id = $1", [vehicleId]);
  if (!v || v.status !== "actif") notFound();
  const last = await q1<{ performed_at: Date; km: number }>("select performed_at, mileage_km as km from inspections where vehicle_id = $1 order by performed_at desc limit 1", [v.id]);
  const maxKm = await q1<{ km: number | null }>("select max(mileage_km) as km from inspections where vehicle_id = $1", [v.id]);
  const planning = vehiclePlanning(v.control_week, (await doneMonths([v.id])).get(v.id) ?? new Set());
  return (
    <Shell user={user} title={`Contrôle ${v.plate}`} back={{ href: "/controle", label: "Changer de véhicule" }}>
      <Wizard
        vehicle={{ id: v.id, plate: v.plate, label: v.label, site: v.site, assignment: v.assignment }}
        contact={await alertContact()}
        planningNote={`Planning : ${planning.current.label.toLowerCase()}.`}
        groups={checklistFor(v)}
        checklistVersion={CHECKLIST_VERSION}
        nacelleMissing={nacelleChecklistMissing(v)}
        lastKm={maxKm?.km ?? null}
        lastDate={last ? fmtDate(last.performed_at) : null}
      />
    </Shell>
  );
}
