import { ApiError, apiHandler, apiUser } from "@/lib/auth";
import { q } from "@/lib/db";
import { REPAIR_STATUS_LABELS, type RepairStatus } from "@/lib/repair-status";
import { SUMMARY_LABELS, type Summary } from "@/lib/checklist";
import { isoDay, pgDate } from "@/lib/format";

const euros = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));
function csv(rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise les formules à l'ouverture dans un tableur
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

// Export à la demande (CSV lisible par Excel). La base reste la seule source : aucun classeur à tenir en parallèle.
export const GET = apiHandler(async (req) => {
  await apiUser("dashboard.view");
  const type = new URL(req.url).searchParams.get("type");
  let rows: unknown[][];
  if (type === "reparations") {
    const data = await q<Record<string, never>>(
      `select v.plate, r.title, r.status, r.urgent, r.garage, r.estimate_ht_cents, r.estimate_ttc_cents, r.actual_ht_cents, r.actual_ttc_cents,
              r.quote_received_on, r.planned_on, r.started_on, r.completed_on, u.name as validated_by, r.validated_at, r.status_reason, r.created_at
       from repairs r join vehicles v on v.id = r.vehicle_id left join users u on u.id = r.validated_by order by r.created_at desc`);
    rows = [["Immatriculation", "Réparation", "Statut", "Urgent", "Garage", "Estimé HT", "Estimé TTC", "Réel HT", "Réel TTC", "Devis reçu le", "Planifié le", "Commencé le", "Terminé le", "Validé par", "Validé le", "Motif refus/annulation", "Créé le"],
      ...data.map((r) => [r.plate, r.title, REPAIR_STATUS_LABELS[r.status as RepairStatus], r.urgent ? "oui" : "non", r.garage, euros(r.estimate_ht_cents), euros(r.estimate_ttc_cents), euros(r.actual_ht_cents), euros(r.actual_ttc_cents),
        pgDate(r.quote_received_on), pgDate(r.planned_on), pgDate(r.started_on), pgDate(r.completed_on), r.validated_by, r.validated_at ? isoDay(r.validated_at) : "", r.status_reason, isoDay(r.created_at)])];
  } else if (type === "controles") {
    const data = await q<Record<string, never>>(
      `select v.plate, i.performed_at, u.name, i.mileage_km, i.summary, i.critical_flag, i.version,
              (select count(*) from inspection_answers a where a.inspection_id = i.id and a.answer = 'intervention') as interventions,
              (select count(*) from inspection_answers a where a.inspection_id = i.id and a.answer = 'a_surveiller') as surveiller,
              (select count(*) from inspection_answers a where a.inspection_id = i.id and a.answer = 'urgent') as urgents,
              (select count(*) from inspection_answers a where a.inspection_id = i.id and a.answer = 'non_verifie') as non_verifies
       from inspections i join vehicles v on v.id = i.vehicle_id join users u on u.id = i.author_id order by i.performed_at desc`);
    rows = [["Immatriculation", "Date", "Technicien", "Kilométrage", "Synthèse", "Signalement critique", "Version", "À surveiller", "À réparer", "Urgents", "Non vérifiés"],
      ...data.map((r) => [r.plate, isoDay(r.performed_at), r.name, r.mileage_km, SUMMARY_LABELS[r.summary as Summary], r.critical_flag ? "oui" : "non", r.version, r.surveiller, r.interventions, r.urgents, r.non_verifies])];
  } else throw new ApiError(400, "Type d'export inconnu.");
  return new Response(csv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="gset_${type}_${isoDay(new Date())}.csv"`, "cache-control": "private, no-store" } });
});
