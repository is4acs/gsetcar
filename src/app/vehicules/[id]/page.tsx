import Link from "next/link";
import { notFound } from "next/navigation";
import { canAccessVehicle, requireUser } from "@/lib/auth";
import { q, q1 } from "@/lib/db";
import { can } from "@/lib/permissions";
import { Badge, Empty, Field, Flash, Shell } from "@/components/ui";
import { folderUrl } from "@/lib/drive";
import { REPAIR_STATUS_LABELS, type RepairStatus } from "@/lib/repair-status";
import { PRIORITY_LABELS, SUMMARY_LABELS, type Priority, type Summary } from "@/lib/checklist";
import { DEADLINE_LABELS, IMMO_LABELS, PRIORITY_TONES, REPAIR_TONES, SUMMARY_TONES, VEHICLE_STATUS_LABELS } from "@/lib/labels";
import { fmtDate, fmtDateTime, fmtKm, fmtMoney, nowMs } from "@/lib/format";
import { addDeadline, closeIssue, createRepair, immobilizeNow, proposeImmobilization, releaseImmobilization, decideImmobilization, setVehicleStatus, updateVehicle } from "@/app/actions";

export default async function VehiclePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id) || !(await canAccessVehicle(user, id))) notFound();
  const v = await q1<{ id: string; plate: string; label: string; nacelle: boolean; status: string; status_confirmed_at: Date | null; site: string | null; assignment: string | null; notes: string | null; control_week: number | null; cg_holder: string | null; cg_status: string | null;
    drive_folder_id: string | null; drive_folder_name: string | null; drive_folder_verified_at: Date | null; drive_controles_folder_id: string | null; drive_factures_folder_id: string | null }>("select * from vehicles where id = $1", [id]);
  if (!v) notFound();
  const budget = can(user.role, "dashboard.view");
  const [inspections, repairs, issues, immos, deadlines, totals] = await Promise.all([
    q<{ id: string; performed_at: Date; mileage_km: number; summary: Summary; author: string }>("select i.id, i.performed_at, i.mileage_km, i.summary, u.name as author from inspections i join users u on u.id = i.author_id where i.vehicle_id = $1 order by i.performed_at desc limit 30", [id]),
    q<{ id: string; title: string; status: RepairStatus; urgent: boolean; garage: string | null; planned_on: Date | null; completed_on: Date | null; estimate_ht_cents: number | null; estimate_ttc_cents: number | null; actual_ht_cents: number | null; actual_ttc_cents: number | null }>(
      "select * from repairs where vehicle_id = $1 order by created_at desc limit 100", [id]),
    q<{ id: string; title: string; description: string | null; priority: Priority | null; created_at: Date; inspection_id: string | null; repair_id: string | null }>(
      `select s.id, s.title, s.description, s.priority, s.created_at, s.inspection_id, (select r.id from repairs r where r.issue_id = s.id and r.status not in ('refuse','annule') limit 1) as repair_id
       from issues s where s.vehicle_id = $1 and s.status = 'ouverte' order by s.created_at desc`, [id]),
    q<{ id: string; status: string; auto_rule: boolean; reason: string; proposed_at: Date; proposer: string; decided_at: Date | null; decider: string | null; decision_note: string | null; released_at: Date | null; releaser: string | null; release_note: string | null }>(
      `select m.*, p.name as proposer, d.name as decider, r.name as releaser from immobilizations m join users p on p.id = m.proposed_by left join users d on d.id = m.decided_by left join users r on r.id = m.released_by
       where m.vehicle_id = $1 order by m.proposed_at desc limit 20`, [id]),
    q<{ id: string; kind: string; due_on: Date; source: string; note: string | null; author: string; created_at: Date }>(
      "select d.*, u.name as author from vehicle_deadlines d join users u on u.id = d.created_by where d.vehicle_id = $1 and d.superseded_at is null order by d.due_on", [id]),
    q1<{ ht: string | null; ttc: string | null; n_ht: number; n_ttc: number; n: number }>(
      `select sum(actual_ht_cents) as ht, sum(actual_ttc_cents) as ttc, count(actual_ht_cents)::int as n_ht, count(actual_ttc_cents)::int as n_ttc, count(*)::int as n from repairs where vehicle_id = $1 and status = 'termine'`, [id]),
  ]);
  const back = `/vehicules/${v.id}`;
  const now = nowMs();
  const activeImmo = immos.find((m) => m.status === "active");
  const pendingImmo = immos.find((m) => m.status === "proposee");
  const done = repairs.filter((r) => r.status === "termine"), planned = repairs.filter((r) => !["termine", "refuse", "annule"].includes(r.status));
  const hidden = <input type="hidden" name="_back" value={back} />;
  return (
    <Shell user={user} title={v.plate} back={budget ? { href: "/direction", label: "Tableau de bord" } : { href: "/", label: "Accueil" }} wide>
      <Flash params={await searchParams} />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-2">
          <h2 className="h2">Identité</h2>
          <p>{v.label}{v.nacelle && <> <Badge tone="blue">Nacelle</Badge></>}</p>
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={v.status === "actif" ? "green" : v.status === "vendu" ? "gray" : "amber"}>{VEHICLE_STATUS_LABELS[v.status]}</Badge>
            {v.status !== "a_confirmer" && (v.status_confirmed_at ? <span className="muted">confirmé le {fmtDate(v.status_confirmed_at)}</span> : <Badge tone="amber">repris du classeur, à confirmer par la direction</Badge>)}
            {activeImmo ? <Badge tone="red">Immobilisé</Badge> : v.status === "actif" && <Badge tone="green">Disponible</Badge>}
          </p>
          <p className="text-sm">Site : {v.site ?? <span className="text-slate-400">non renseigné</span>} · Conducteur affecté : {v.assignment ?? <span className="text-slate-400">non renseigné</span>} · Contrôle mensuel : {v.control_week ? `semaine S${v.control_week}` : <span className="text-slate-400">semaine non définie</span>}</p>
          {(v.cg_holder || v.cg_status) && <p className="text-sm">Carte grise : {[v.cg_holder && `titulaire ${v.cg_holder}`, v.cg_status && `statut ${v.cg_status}`].filter(Boolean).join(" · ")} <span className="muted">(repris du classeur)</span></p>}
          <p className="text-sm">Dernier kilométrage relevé : {fmtKm(inspections.length ? Math.max(...inspections.map((i) => i.mileage_km)) : null)}</p>
          {v.notes && <p className="text-sm text-slate-700">{v.notes}</p>}
          <p className="text-sm">
            {v.drive_folder_id ? <a href={folderUrl(v.drive_folder_id)} target="_blank" rel="noreferrer" className="text-blue-700 underline">Dossier Drive{v.drive_folder_name ? ` « ${v.drive_folder_name} »` : ""}</a> : <Badge tone="red">Dossier Drive à localiser</Badge>}
            {v.drive_folder_id && (v.drive_folder_verified_at ? <span className="muted"> · accès vérifié le {fmtDate(v.drive_folder_verified_at)}</span> : <> <Badge tone="amber">accès non vérifié</Badge></>)}
            {v.drive_controles_folder_id && <> · <a href={folderUrl(v.drive_controles_folder_id)} target="_blank" rel="noreferrer" className="text-blue-700 underline">Contrôles</a></>}
            {v.drive_factures_folder_id && <> · <a href={folderUrl(v.drive_factures_folder_id)} target="_blank" rel="noreferrer" className="text-blue-700 underline">Factures</a></>}
          </p>
          {can(user.role, "inspection.create") && v.status === "actif" && <Link href={`/controle/${v.id}`} className="btn-primary w-full">Contrôler ce véhicule</Link>}
          {can(user.role, "vehicle.edit") && (
            <details><summary className="cursor-pointer text-sm font-medium text-blue-700">Modifier site, conducteur, semaine, notes</summary>
              <form action={updateVehicle} className="mt-2 space-y-2">{hidden}<input type="hidden" name="id" value={v.id} />
                <Field label="Site"><input name="site" className="input" defaultValue={v.site ?? ""} /></Field>
                <Field label="Conducteur affecté"><input name="assignment" className="input" defaultValue={v.assignment ?? ""} /></Field>
                <Field label="Semaine du contrôle mensuel"><select name="control_week" defaultValue={v.control_week ?? ""} className="input"><option value="">Non définie</option>{[1, 2, 3, 4].map((w) => <option key={w} value={w}>S{w}</option>)}</select></Field>
                <Field label="Notes"><textarea name="notes" className="input" rows={2} defaultValue={v.notes ?? ""} /></Field>
                <button className="btn-secondary btn-sm">Enregistrer</button></form></details>
          )}
          {can(user.role, "vehicle.status") && (
            <form action={setVehicleStatus} className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">{hidden}<input type="hidden" name="id" value={v.id} />
              <label className="text-sm"><span className="label">Confirmer le statut du véhicule</span>
                <select name="status" defaultValue={v.status} className="input min-h-10"><option value="actif">Actif</option><option value="vendu">Vendu</option><option value="a_confirmer">À confirmer</option></select></label>
              <button className="btn-secondary btn-sm min-h-10">Confirmer</button></form>
          )}
        </section>

        <section className="card space-y-2">
          <h2 className="h2">Immobilisation</h2>
          {activeImmo && (
            <div className="space-y-2 rounded-xl bg-red-50 p-3 text-sm">
              <p><b>Véhicule immobilisé</b> — {activeImmo.auto_rule ? `déclaré automatiquement au contrôle de ${activeImmo.proposer}` : `décision de ${activeImmo.decider}`} le {fmtDateTime(activeImmo.decided_at)}. Motif : {activeImmo.reason}{activeImmo.decision_note ? ` (${activeImmo.decision_note})` : ""}</p>
              {can(user.role, "immobilization.decide") && <form action={releaseImmobilization} className="flex flex-wrap gap-2">{hidden}<input type="hidden" name="id" value={activeImmo.id} /><input name="note" required className="input min-h-9 flex-1 text-sm" placeholder="Base de la remise en circulation (obligatoire)" /><button className="btn-primary btn-sm">Autoriser la remise en circulation</button></form>}
            </div>
          )}
          {pendingImmo && (
            <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-sm">
              <p><b>Immobilisation proposée</b> par {pendingImmo.proposer} le {fmtDateTime(pendingImmo.proposed_at)} : {pendingImmo.reason}</p>
              {can(user.role, "immobilization.decide") ? <form action={decideImmobilization} className="flex flex-wrap gap-2">{hidden}<input type="hidden" name="id" value={pendingImmo.id} /><input name="note" className="input min-h-9 flex-1 text-sm" placeholder="Note (facultative)" /><button name="decision" value="accepter" className="btn-danger btn-sm">Immobiliser</button><button name="decision" value="rejeter" className="btn-secondary btn-sm">Ne pas immobiliser</button></form> : <p>En attente de décision de la direction.</p>}
            </div>
          )}
          {!activeImmo && !pendingImmo && <Empty>Aucune immobilisation en cours.</Empty>}
          {!activeImmo && !pendingImmo && (
            <details><summary className="cursor-pointer text-sm font-medium text-red-700">{can(user.role, "immobilization.decide") ? "Immobiliser ce véhicule" : "Proposer l'immobilisation"}</summary>
              <form action={can(user.role, "immobilization.decide") ? immobilizeNow : proposeImmobilization} className="mt-2 space-y-2">{hidden}<input type="hidden" name="vehicleId" value={v.id} /><textarea name="reason" required className="input" rows={2} placeholder="Motif" /><button className="btn-danger btn-sm">Confirmer</button></form></details>
          )}
          {immos.filter((m) => m.status === "levee" || m.status === "rejetee").map((m) => (
            <p key={m.id} className="muted">{IMMO_LABELS[m.status]} — {m.reason} · proposé par {m.proposer} le {fmtDate(m.proposed_at)}{m.decider ? ` · décision ${m.decider}` : ""}{m.released_at ? ` · remis en service par ${m.releaser} le ${fmtDate(m.released_at)} (${m.release_note})` : ""}</p>
          ))}
        </section>
      </div>

      <section className="card space-y-2">
        <h2 className="h2">Échéances</h2>
        {deadlines.length === 0 && <Empty>Aucune échéance enregistrée (CT, assurance, entretien). Aucune date n&apos;est déduite automatiquement.</Empty>}
        {deadlines.map((d) => <div key={d.id} className="flex flex-wrap items-center gap-2 text-sm"><b>{DEADLINE_LABELS[d.kind]}</b><Badge tone={new Date(d.due_on).getTime() < now ? "red" : "gray"}>{fmtDate(d.due_on)}</Badge><span className="muted">source : {d.source} · saisi par {d.author} le {fmtDate(d.created_at)}{d.note ? ` · ${d.note}` : ""}</span></div>)}
        {can(user.role, "vehicle.edit") && (
          <details><summary className="cursor-pointer text-sm font-medium text-blue-700">Ajouter ou remplacer une échéance</summary>
            <form action={addDeadline} className="mt-2 grid gap-2 sm:grid-cols-4">{hidden}<input type="hidden" name="vehicleId" value={v.id} />
              <select name="kind" className="input">{Object.entries(DEADLINE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input type="date" name="due_on" required className="input" />
              <input name="source" required className="input sm:col-span-2" placeholder="Provenance (ex. PV de CT du 12/03, attestation assureur)" />
              <input name="note" className="input sm:col-span-3" placeholder="Note (facultative)" /><button className="btn-secondary">Ajouter</button></form></details>
        )}
      </section>

      <section className="card space-y-2">
        <h2 className="h2">Anomalies ouvertes</h2>
        {issues.length === 0 && <Empty>Aucune anomalie ouverte.</Empty>}
        {issues.map((s) => (
          <div key={s.id} className="space-y-1 border-b border-slate-100 pb-2 text-sm last:border-0">
            <div className="flex flex-wrap items-center gap-2">{s.priority ? <Badge tone={PRIORITY_TONES[s.priority]}>{PRIORITY_LABELS[s.priority]}</Badge> : <Badge tone="amber">À surveiller</Badge>}<b>{s.title}</b><span className="muted">{fmtDate(s.created_at)}</span>
              {s.inspection_id && <Link href={`/controles/${s.inspection_id}`} className="text-blue-700 underline">contrôle</Link>}
              {s.repair_id ? <Link href={`/reparations/${s.repair_id}`} className="text-blue-700 underline">réparation liée</Link>
                : can(user.role, "repair.edit") && <form action={createRepair}>{hidden}<input type="hidden" name="issueId" value={s.id} /><button className="btn-secondary btn-sm">Créer la réparation</button></form>}
            </div>
            {s.description && <p className="text-slate-700">{s.description}</p>}
            {can(user.role, "issue.close") && !s.repair_id && <form action={closeIssue} className="flex gap-2">{hidden}<input type="hidden" name="id" value={s.id} /><input name="reason" required className="input min-h-9 flex-1 text-sm" placeholder="Classer sans réparation : motif" /><button className="btn-secondary btn-sm">Classer</button></form>}
          </div>
        ))}
      </section>

      <section className="card space-y-2">
        <h2 className="h2">Travaux prévus ou en cours</h2>
        {planned.length === 0 && <Empty>Aucun.</Empty>}
        {planned.map((r) => <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm"><Link href={`/reparations/${r.id}`} className="text-blue-700 underline">{r.title}</Link><Badge tone={REPAIR_TONES[r.status]}>{REPAIR_STATUS_LABELS[r.status]}</Badge>{r.urgent && <Badge tone="red">Urgent</Badge>}<span className="muted">{[r.garage, r.planned_on && `prévu le ${fmtDate(r.planned_on)}`, budget && `estimé ${fmtMoney(r.estimate_ht_cents)} HT / ${fmtMoney(r.estimate_ttc_cents)} TTC`].filter(Boolean).join(" · ")}</span></div>)}
        {can(user.role, "repair.edit") && (
          <details><summary className="cursor-pointer text-sm font-medium text-blue-700">Créer une réparation sans contrôle</summary>
            <form action={createRepair} className="mt-2 space-y-2">{hidden}<input type="hidden" name="vehicleId" value={v.id} /><input name="title" required className="input" placeholder="Objet de la réparation" /><textarea name="description" className="input" rows={2} placeholder="Description" /><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="urgent" className="h-5 w-5" /> Urgent</label><button className="btn-secondary btn-sm">Créer</button></form></details>
        )}
      </section>

      <section className="card space-y-2">
        <h2 className="h2">Travaux réalisés</h2>
        {done.length === 0 && <Empty>Aucun travail terminé enregistré dans l&apos;application.</Empty>}
        {done.map((r) => <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm"><Link href={`/reparations/${r.id}`} className="text-blue-700 underline">{r.title}</Link><span className="muted">{[r.completed_on && `terminé le ${fmtDate(r.completed_on)}`, r.garage, budget && `réel ${fmtMoney(r.actual_ht_cents)} HT / ${fmtMoney(r.actual_ttc_cents)} TTC`].filter(Boolean).join(" · ")}</span></div>)}
        {budget && totals && totals.n > 0 && (
          <p className="rounded-xl bg-slate-50 p-3 text-sm">
            <b>Dépenses réelles (travaux terminés)</b> — HT : {totals.n_ht ? fmtMoney(Number(totals.ht)) : "Non renseigné"}{totals.n_ht < totals.n && totals.n_ht > 0 ? ` (sur ${totals.n_ht}/${totals.n} travaux renseignés)` : ""} · TTC : {totals.n_ttc ? fmtMoney(Number(totals.ttc)) : "Non renseigné"}{totals.n_ttc < totals.n && totals.n_ttc > 0 ? ` (sur ${totals.n_ttc}/${totals.n} travaux renseignés)` : ""}
          </p>
        )}
      </section>

      <section className="card space-y-2">
        <h2 className="h2">Historique des contrôles</h2>
        {inspections.length === 0 && <Empty>Aucun contrôle enregistré dans l&apos;application.</Empty>}
        {inspections.length > 0 && <div className="overflow-x-auto"><table className="table"><thead><tr><th>Date</th><th>Kilométrage</th><th>Synthèse</th><th>Technicien</th></tr></thead><tbody>
          {inspections.map((i) => <tr key={i.id}><td><Link href={`/controles/${i.id}`} className="text-blue-700 underline">{fmtDateTime(i.performed_at)}</Link></td><td>{fmtKm(i.mileage_km)}</td><td><Badge tone={SUMMARY_TONES[i.summary]}>{SUMMARY_LABELS[i.summary]}</Badge></td><td>{i.author}</td></tr>)}
        </tbody></table></div>}
      </section>
    </Shell>
  );
}
