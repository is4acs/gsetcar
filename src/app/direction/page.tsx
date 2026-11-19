import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { q, q1 } from "@/lib/db";
import { can } from "@/lib/permissions";
import { Badge, Empty, Flash, Shell } from "@/components/ui";
import { listVehicles } from "@/lib/queries";
import { doneMonths, vehiclePlanning } from "@/lib/planning";
import { REPAIR_STATUS_LABELS, OPEN_REPAIR_STATUSES, type RepairStatus } from "@/lib/repair-status";
import { PRIORITY_LABELS, PRIORITIES, SUMMARY_LABELS, type Priority } from "@/lib/checklist";
import { DEADLINE_LABELS, PRIORITY_TONES, REPAIR_TONES, SUMMARY_TONES } from "@/lib/labels";
import { fmtDate, fmtDateTime, fmtKm, fmtMoney, fmtMonth, nowMs } from "@/lib/format";
import { acknowledgeCritical, decideImmobilization } from "@/app/actions";

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requirePermission("dashboard.view");
  const sp = await searchParams;
  const f = { plate: sp.plaque ?? "", site: sp.site ?? "", priority: sp.priorite ?? "", status: sp.statut ?? "" };
  const all = await listVehicles(user);
  const active = all.filter((v) => v.status === "actif");
  const sites = [...new Set(all.map((v) => v.site).filter(Boolean))] as string[];
  const vehicles = active.filter((v) => (!f.plate || v.plate === f.plate) && (!f.site || v.site === f.site));
  const ids = vehicles.map((v) => v.id);

  const now = nowMs();
  const done = await doneMonths(ids);
  const plan = new Map(vehicles.map((v) => [v.id, vehiclePlanning(v.control_week, done.get(v.id) ?? new Set(), new Date(now))]));

  const [criticals, proposals, repairs, issues, jobs, deadlines] = await Promise.all([
    q<{ id: string; plate: string; critical_comment: string; performed_at: Date; author: string }>(
      `select i.id, v.plate, i.critical_comment, i.performed_at, u.name as author from inspections i join vehicles v on v.id = i.vehicle_id join users u on u.id = i.author_id
       where i.critical_flag and i.critical_ack_at is null and i.vehicle_id = any($1) order by i.performed_at desc`, [ids]),
    q<{ id: string; plate: string; vehicle_id: string; reason: string; proposed_at: Date; proposer: string }>(
      `select m.id, v.plate, m.vehicle_id, m.reason, m.proposed_at, u.name as proposer from immobilizations m join vehicles v on v.id = m.vehicle_id join users u on u.id = m.proposed_by
       where m.status = 'proposee' and m.vehicle_id = any($1) order by m.proposed_at`, [ids]),
    q<{ id: string; title: string; status: RepairStatus; urgent: boolean; plate: string; garage: string | null; estimate_ht_cents: number | null; estimate_ttc_cents: number | null; planned_on: Date | null; priority: Priority | null }>(
      `select r.id, r.title, r.status, r.urgent, r.garage, r.estimate_ht_cents, r.estimate_ttc_cents, r.planned_on, v.plate, s.priority from repairs r join vehicles v on v.id = r.vehicle_id left join issues s on s.id = r.issue_id
       where r.vehicle_id = any($1) and r.status = any($2) and ($3 = '' or s.priority = $3 or ($3 = 'urgent' and r.urgent))
       order by r.urgent desc, array_position($4::text[], r.status::text), r.updated_at desc`, [ids, f.status ? [f.status] : OPEN_REPAIR_STATUSES, f.priority, OPEN_REPAIR_STATUSES]),
    q<{ id: string; title: string; priority: Priority | null; plate: string; vehicle_id: string; inspection_id: string | null; created_at: Date }>(
      `select s.id, s.title, s.priority, v.plate, s.vehicle_id, s.inspection_id, s.created_at from issues s join vehicles v on v.id = s.vehicle_id
       where s.status = 'ouverte' and s.vehicle_id = any($1) and ($2 = '' or s.priority = $2)
         and not exists (select 1 from repairs r where r.issue_id = s.id and r.status not in ('refuse','annule'))
       order by array_position(array['urgent','15_jours','1_mois','prochain_entretien'], s.priority) nulls last, s.created_at`, [ids, f.priority]),
    q1<{ pending: number; problems: number }>("select count(*) filter (where status <> 'termine')::int as pending, count(*) filter (where status in ('bloque','echec'))::int as problems from drive_jobs"),
    q<{ plate: string; vehicle_id: string; kind: string; due_on: Date; source: string }>(
      `select v.plate, d.vehicle_id, d.kind, d.due_on, d.source from vehicle_deadlines d join vehicles v on v.id = d.vehicle_id
       where d.superseded_at is null and d.vehicle_id = any($1) and d.due_on < current_date + 60 order by d.due_on`, [ids]),
  ]);
  const toValidate = repairs.filter((r) => r.status === "a_valider");
  const urgentRepairs = repairs.filter((r) => r.urgent);
  const immobilized = vehicles.filter((v) => v.immobilized);
  const due = vehicles.filter((v) => plan.get(v.id)!.current.due || plan.get(v.id)!.lateMonths.length > 0);
  const unconfirmed = all.filter((v) => v.status === "a_confirmer" || !v.status_confirmed_at);
  const back = "/direction";
  const tiles: [string, number | string, string, boolean][] = [
    ["Disponibles", vehicles.length - immobilized.length, "#parc", false],
    ["Immobilisés", immobilized.length, "#parc", immobilized.length > 0],
    ["Contrôles dus ou en retard", due.length, "#parc", due.length > 0],
    ["Urgences", criticals.length + proposals.length + urgentRepairs.length, "#urgences", criticals.length + proposals.length + urgentRepairs.length > 0],
    ["Réparations ouvertes", repairs.length, "#reparations", false],
    ["Devis à valider", toValidate.length, "#valider", toValidate.length > 0],
    ["Documents en attente d'envoi", jobs?.pending ?? 0, "/envois", (jobs?.problems ?? 0) > 0],
  ];
  return (
    <Shell user={user} title="Tableau de bord" wide>
      <Flash params={sp} />
      <form className="card flex flex-wrap items-end gap-3 text-sm">
        <label><span className="label">Plaque</span><select name="plaque" defaultValue={f.plate} className="input min-h-10"><option value="">Toutes</option>{active.map((v) => <option key={v.id}>{v.plate}</option>)}</select></label>
        <label><span className="label">Site</span><select name="site" defaultValue={f.site} className="input min-h-10"><option value="">Tous</option>{sites.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label><span className="label">Priorité</span><select name="priorite" defaultValue={f.priority} className="input min-h-10"><option value="">Toutes</option>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}</select></label>
        <label><span className="label">Statut réparation</span><select name="statut" defaultValue={f.status} className="input min-h-10"><option value="">Ouvertes</option>{Object.entries(REPAIR_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <button className="btn-primary btn-sm min-h-10">Filtrer</button>
        <Link href="/direction" className="btn-secondary btn-sm min-h-10">Réinitialiser</Link>
        <span className="ml-auto flex gap-3"><a className="text-blue-700 underline" href="/api/export?type=reparations">Export réparations (CSV)</a><a className="text-blue-700 underline" href="/api/export?type=controles">Export contrôles (CSV)</a></span>
      </form>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {tiles.map(([label, value, href, alert]) => (
          <a key={label} href={href} className={`card !p-3 ${alert ? "border-red-300 bg-red-50" : ""}`}>
            <div className={`text-3xl font-bold ${alert ? "text-red-700" : ""}`}>{value}</div>
            <div className="text-xs font-medium text-slate-600">{label}</div>
          </a>
        ))}
      </div>
      <p className="muted">Un contrôle par véhicule et par mois, selon la semaine prévue (S1 à S4). « Dus ou en retard » : semaine prévue atteinte ou dépassée ce mois-ci, ou mois passé sans contrôle. <Link className="text-blue-700 underline" href="/planning">Voir le planning et le registre</Link></p>
      {unconfirmed.length > 0 && <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">Statut à confirmer par la direction (actif / vendu) : {unconfirmed.map((v) => <Link key={v.id} href={`/vehicules/${v.id}`} className="mr-2 font-mono font-semibold underline">{v.plate}</Link>)}</p>}

      <section id="urgences" className="card space-y-3">
        <h2 className="h2">Urgences</h2>
        {criticals.length + proposals.length + urgentRepairs.length === 0 && <Empty>Aucune urgence en cours.</Empty>}
        {criticals.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-50 p-3 text-sm">
            <div><b className="font-mono">{c.plate}</b> — problème critique signalé par {c.author} le {fmtDateTime(c.performed_at)} : {c.critical_comment} <Link href={`/controles/${c.id}`} className="text-blue-700 underline">voir le contrôle</Link></div>
            {can(user.role, "immobilization.decide") && <form action={acknowledgeCritical}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="_back" value={back} /><button className="btn-secondary btn-sm">Pris en compte</button></form>}
          </div>
        ))}
        {proposals.map((p) => (
          <div key={p.id} className="space-y-2 rounded-xl bg-red-50 p-3 text-sm">
            <div><Link href={`/vehicules/${p.vehicle_id}`} className="font-mono font-bold underline">{p.plate}</Link> — immobilisation proposée par {p.proposer} le {fmtDateTime(p.proposed_at)} : {p.reason}</div>
            {can(user.role, "immobilization.decide") && (
              <form action={decideImmobilization} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={p.id} /><input type="hidden" name="_back" value={back} />
                <input name="note" className="input min-h-9 flex-1 text-sm" placeholder="Note (facultative)" />
                <button name="decision" value="accepter" className="btn-danger btn-sm">Immobiliser</button>
                <button name="decision" value="rejeter" className="btn-secondary btn-sm">Ne pas immobiliser</button>
              </form>
            )}
          </div>
        ))}
        {urgentRepairs.map((r) => <div key={r.id} className="rounded-xl bg-red-50 p-3 text-sm"><b className="font-mono">{r.plate}</b> — réparation urgente : <Link href={`/reparations/${r.id}`} className="text-blue-700 underline">{r.title}</Link> <Badge tone={REPAIR_TONES[r.status]}>{REPAIR_STATUS_LABELS[r.status]}</Badge></div>)}
      </section>

      <section id="valider" className="card space-y-2">
        <h2 className="h2">Devis à valider</h2>
        {toValidate.length === 0 ? <Empty>Aucun devis en attente de validation.</Empty> : (
          <div className="overflow-x-auto"><table className="table"><thead><tr><th>Véhicule</th><th>Réparation</th><th>Garage</th><th>Estimé HT</th><th>Estimé TTC</th><th /></tr></thead><tbody>
            {toValidate.map((r) => <tr key={r.id}><td className="font-mono font-semibold">{r.plate}</td><td>{r.title}</td><td>{r.garage ?? "—"}</td><td>{fmtMoney(r.estimate_ht_cents)}</td><td>{fmtMoney(r.estimate_ttc_cents)}</td><td><Link href={`/reparations/${r.id}`} className="text-blue-700 underline">{can(user.role, "repair.validate") ? "Valider / refuser" : "Ouvrir"}</Link></td></tr>)}
          </tbody></table></div>
        )}
      </section>

      <section id="parc" className="card space-y-2">
        <h2 className="h2">Parc actif</h2>
        <div className="overflow-x-auto"><table className="table"><thead><tr><th>Véhicule</th><th>Site / affectation</th><th>État</th><th>Dernier contrôle</th><th>Contrôle du mois</th><th>Km</th><th>Rép. ouvertes</th><th>Drive</th></tr></thead><tbody>
          {vehicles.map((v) => { const d = plan.get(v.id)!; return (
            <tr key={v.id}>
              <td><Link href={`/vehicules/${v.id}`} className="font-mono font-semibold text-blue-700 underline">{v.plate}</Link><div className="muted">{v.label}</div></td>
              <td>{[v.site, v.assignment].filter(Boolean).join(" · ") || <span className="text-slate-400">Non renseigné</span>}</td>
              <td>{v.immobilized ? <Badge tone="red">Immobilisé</Badge> : <Badge tone="green">Disponible</Badge>}{v.immobilization_proposed && <div><Badge tone="amber">Immobilisation proposée</Badge></div>}</td>
              <td>{v.last_inspection_id ? <Link href={`/controles/${v.last_inspection_id}`} className="underline">{fmtDate(v.last_inspection_at)}</Link> : "—"}{v.last_summary && <div><Badge tone={SUMMARY_TONES[v.last_summary]}>{SUMMARY_LABELS[v.last_summary].split(" :")[0]}</Badge></div>}</td>
              <td><Badge tone={d.current.tone}>{d.current.label}</Badge>{d.lateMonths.length > 0 && <div><Badge tone="red">En retard : {d.lateMonths.map((m) => fmtMonth(m, true)).join(", ")}</Badge></div>}</td>
              <td>{fmtKm(v.last_km)}</td>
              <td>{v.open_repairs}</td>
              <td>{!v.drive_folder_id ? <Badge tone="red">Dossier à localiser</Badge> : v.drive_folder_verified_at ? <Badge tone="green">Vérifié</Badge> : <Badge tone="amber">Non vérifié</Badge>}</td>
            </tr>); })}
        </tbody></table></div>
      </section>

      <section id="reparations" className="card space-y-2">
        <h2 className="h2">Réparations {f.status ? `— ${REPAIR_STATUS_LABELS[f.status as RepairStatus] ?? ""}` : "ouvertes"}</h2>
        {repairs.length === 0 ? <Empty>Aucune réparation pour ces filtres.</Empty> : (
          <div className="overflow-x-auto"><table className="table"><thead><tr><th>Véhicule</th><th>Réparation</th><th>Statut</th><th>Priorité</th><th>Garage</th><th>Prévu le</th><th>Estimé HT</th><th>Estimé TTC</th></tr></thead><tbody>
            {repairs.map((r) => <tr key={r.id}><td className="font-mono font-semibold">{r.plate}</td><td><Link href={`/reparations/${r.id}`} className="text-blue-700 underline">{r.title}</Link></td>
              <td><Badge tone={REPAIR_TONES[r.status]}>{REPAIR_STATUS_LABELS[r.status]}</Badge></td><td>{r.urgent ? <Badge tone="red">Urgent</Badge> : r.priority ? <Badge tone={PRIORITY_TONES[r.priority]}>{PRIORITY_LABELS[r.priority]}</Badge> : "—"}</td>
              <td>{r.garage ?? "—"}</td><td>{fmtDate(r.planned_on)}</td><td>{fmtMoney(r.estimate_ht_cents)}</td><td>{fmtMoney(r.estimate_ttc_cents)}</td></tr>)}
          </tbody></table></div>
        )}
      </section>

      <section className="card space-y-2">
        <h2 className="h2">Anomalies ouvertes sans réparation</h2>
        {issues.length === 0 ? <Empty>Aucune.</Empty> : issues.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm"><Link href={`/vehicules/${s.vehicle_id}`} className="font-mono font-semibold underline">{s.plate}</Link>{s.priority ? <Badge tone={PRIORITY_TONES[s.priority]}>{PRIORITY_LABELS[s.priority]}</Badge> : <Badge tone="amber">À surveiller</Badge>}<span>{s.title}</span><span className="muted">depuis le {fmtDate(s.created_at)}</span></div>
        ))}
      </section>

      <section className="card space-y-2">
        <h2 className="h2">Échéances à moins de 60 jours ou dépassées</h2>
        {deadlines.length === 0 ? <Empty>Aucune échéance enregistrée dans cette période. Les échéances non saisies n&apos;apparaissent pas : aucune date n&apos;est déduite automatiquement.</Empty> : deadlines.map((d, n) => (
          <div key={n} className="flex flex-wrap items-center gap-2 text-sm"><Link href={`/vehicules/${d.vehicle_id}`} className="font-mono font-semibold underline">{d.plate}</Link><span>{DEADLINE_LABELS[d.kind]}</span>
            <Badge tone={new Date(d.due_on).getTime() < now ? "red" : "amber"}>{fmtDate(d.due_on)}</Badge><span className="muted">source : {d.source}</span></div>
        ))}
      </section>
    </Shell>
  );
}
