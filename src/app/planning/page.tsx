import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { q } from "@/lib/db";
import { Badge, Empty, Shell } from "@/components/ui";
import { listVehicles } from "@/lib/queries";
import { doneMonths, planningMonths, planningStatus, PLANNING_START } from "@/lib/planning";
import { PLANNING_LABELS, SUMMARY_LABELS, type Summary } from "@/lib/checklist";
import { SUMMARY_TONES } from "@/lib/labels";
import { fmtDate, fmtKm, fmtMonth, localParts } from "@/lib/format";

const TZ = process.env.NEXT_PUBLIC_APP_TIMEZONE || "America/Cayenne";

// Équivalent des onglets « Planning » et « Registre contrôles » du classeur, calculés à partir des contrôles
// enregistrés : aucune ligne à saisir à la main.
export default async function Planning() {
  const user = await requirePermission("dashboard.view");
  const vehicles = (await listVehicles(user, { activeOnly: true })).sort((a, b) => (a.control_week ?? 9) - (b.control_week ?? 9) || a.plate.localeCompare(b.plate));
  const ids = vehicles.map((v) => v.id);
  const done = await doneMonths(ids);
  const months = planningMonths();
  const current = localParts().month;
  const register = await q<{ id: string; performed_at: Date; month: string; plate: string; label: string; author: string; mileage_km: number; summary: Summary; surveiller: number; reparer: number; urgents: number;
    report_id: string | null; report_synced: boolean | null }>(
    `select i.id, i.performed_at, to_char(i.performed_at at time zone $2, 'YYYY-MM') as month, v.plate, v.label, u.name as author, i.mileage_km, i.summary,
            (select count(*)::int from inspection_answers a where a.inspection_id = i.id and a.answer = 'a_surveiller') as surveiller,
            (select count(*)::int from inspection_answers a where a.inspection_id = i.id and a.answer = 'intervention') as reparer,
            (select count(*)::int from inspection_answers a where a.inspection_id = i.id and a.answer = 'urgent') as urgents,
            d.id as report_id, d.sync_status = 'depose' as report_synced
     from inspections i join vehicles v on v.id = i.vehicle_id join users u on u.id = i.author_id
     left join lateral (select id, sync_status from documents where inspection_id = i.id and kind = 'rapport_controle' order by version desc limit 1) d on true
     where i.vehicle_id = any($1) order by i.performed_at desc limit 200`, [ids, TZ]);
  const cell = (vehicleId: string, month: string) => (month < PLANNING_START ? null : planningStatus(month, current, done.get(vehicleId) ?? new Set()));
  const TONE = { fait: "green", a_faire: "gray", en_retard: "red" } as const;
  return (
    <Shell user={user} title="Planning des contrôles mensuels" wide>
      <p className="muted">Chaque véhicule est contrôlé une fois par mois, deux véhicules par semaine (S1 : du 1 au 7, S2 : 8 au 14, S3 : 15 au 21, S4 : 22 à la fin du mois). Fait = contrôle enregistré dans le mois ; En retard = mois passé sans contrôle ; À faire = mois en cours ou à venir. La semaine se modifie sur la fiche du véhicule.</p>
      <section className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Véhicule</th><th>Semaine</th>{months.map((m) => <th key={m} className={m === current ? "bg-blue-50" : ""}>{fmtMonth(m, true)}</th>)}</tr></thead>
          <tbody>
            {vehicles.map((v) => (
              <tr key={v.id}>
                <td><Link href={`/vehicules/${v.id}`} className="font-mono font-semibold text-blue-700 underline">{v.plate}</Link><div className="muted">{v.label}</div></td>
                <td>{v.control_week ? `S${v.control_week}` : <Badge tone="amber">Non définie</Badge>}</td>
                {months.map((m) => { const st = cell(v.id, m); return <td key={m} className={m === current ? "bg-blue-50" : ""}>{st ? <Badge tone={TONE[st]}>{PLANNING_LABELS[st]}</Badge> : "—"}</td>; })}
              </tr>
            ))}
            <tr>
              <td colSpan={2} className="font-semibold">Taux de réalisation</td>
              {months.map((m) => <td key={m} className={`font-semibold ${m === current ? "bg-blue-50" : ""}`}>{vehicles.length && m >= PLANNING_START ? `${Math.round((vehicles.filter((v) => done.get(v.id)?.has(m)).length / vehicles.length) * 100)} %` : "—"}</td>)}
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="h2">Registre des contrôles</h2>
          <a className="text-sm text-blue-700 underline" href="/api/export?type=controles">Exporter (CSV)</a>
        </div>
        <p className="muted">Une ligne par contrôle validé, créée automatiquement avec le lien vers la fiche classée dans Drive.</p>
        {register.length === 0 ? <Empty>Aucun contrôle enregistré. La ligne d&apos;exemple du classeur n&apos;a pas été reprise.</Empty> : (
          <div className="overflow-x-auto"><table className="table">
            <thead><tr><th>Date</th><th>Mois</th><th>Véhicule</th><th>Contrôleur</th><th>Km relevé</th><th>À surveiller</th><th>À réparer</th><th>Urgents</th><th>Résultat</th><th>Fiche Drive</th></tr></thead>
            <tbody>
              {register.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/controles/${r.id}`} className="text-blue-700 underline">{fmtDate(r.performed_at)}</Link></td><td>{fmtMonth(r.month, true)}</td>
                  <td><span className="font-mono font-semibold">{r.plate}</span><div className="muted">{r.label}</div></td><td>{r.author}</td><td>{fmtKm(r.mileage_km)}</td>
                  <td>{r.surveiller}</td><td>{r.reparer}</td><td>{r.urgents}</td>
                  <td><Badge tone={SUMMARY_TONES[r.summary]}>{SUMMARY_LABELS[r.summary].split(" :")[0]}</Badge></td>
                  <td>{r.report_id ? <a href={`/api/documents/${r.report_id}`} target="_blank" rel="noreferrer" className="text-blue-700 underline">{r.report_synced ? "Classée" : "En attente"}</a> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </Shell>
  );
}
