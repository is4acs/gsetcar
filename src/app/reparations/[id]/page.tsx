import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { canAccessVehicle, requireUser } from "@/lib/auth";
import { q, q1 } from "@/lib/db";
import { can } from "@/lib/permissions";
import { Badge, Field, Flash, Shell } from "@/components/ui";
import { allowedTransitions, REPAIR_STATUS_LABELS, requiresReason, VALIDATED_STATUSES, type RepairStatus } from "@/lib/repair-status";
import { DOC_KIND_LABELS, JOB_LABELS, JOB_TONES, REPAIR_TONES } from "@/lib/labels";
import { centsToInput, fmtDate, fmtDateTime, fmtMoney, pgDate } from "@/lib/format";
import { proposeImmobilization, transitionRepair, updateRepair, uploadRepairDocument } from "@/app/actions";

type Repair = { id: string; vehicle_id: string; issue_id: string | null; title: string; description: string | null; status: RepairStatus; urgent: boolean; garage: string | null;
  estimate_ht_cents: number | null; estimate_ttc_cents: number | null; actual_ht_cents: number | null; actual_ttc_cents: number | null;
  quote_received_on: Date | null; planned_on: Date | null; started_on: Date | null; completed_on: Date | null; validated_at: Date | null; validator: string | null; status_reason: string | null;
  plate: string; label: string; inspection_id: string | null; creator: string; created_at: Date };

const ACTION_LABELS: Partial<Record<RepairStatus, string>> = { devis_recu: "Devis reçu", a_valider: "Demander la validation", valide: "Valider la dépense", refuse: "Refuser", planifie: "Planifié", en_cours: "Travaux commencés", termine: "Travaux terminés", a_chiffrer: "Revenir à « À chiffrer »", annule: "Annuler la réparation" };

export default async function RepairPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await q1<Repair>(
    `select r.*, v.plate, v.label, s.inspection_id, c.name as creator, u.name as validator from repairs r join vehicles v on v.id = r.vehicle_id join users c on c.id = r.created_by
     left join issues s on s.id = r.issue_id left join users u on u.id = r.validated_by where r.id = $1`, [id]);
  if (!r || !(await canAccessVehicle(user, r.vehicle_id))) notFound();
  const docs = await q<{ id: string; kind: string; filename: string; sync_status: string; job_status: string | null; created_at: Date }>(
    "select d.id, d.kind, d.filename, d.sync_status, d.created_at, j.status as job_status from documents d left join drive_jobs j on j.document_id = d.id where d.repair_id = $1 order by d.created_at", [id]);
  const history = await q<{ at: Date; name: string | null; details: { de: RepairStatus; vers: RepairStatus; motif: string | null } }>(
    "select l.at, u.name, l.details from audit_log l left join users u on u.id = l.user_id where l.entity = 'repair' and l.entity_id = $1 and l.action = 'reparation_statut' order by l.at", [id]);
  const back = `/reparations/${r.id}`;
  const editable = can(user.role, "repair.edit") && (!["termine", "annule"].includes(r.status) || can(user.role, "repair.validate"));
  const estimateLocked = [...VALIDATED_STATUSES, "a_valider"].includes(r.status) && !can(user.role, "repair.edit_validated_estimate");
  const next = allowedTransitions(user.role, r.status);
  const forward = next.filter((s) => !requiresReason(s) && s !== "a_chiffrer");
  const withReason = next.filter(requiresReason);
  const d = (x: Date | null) => pgDate(x) ?? "";
  return (
    <Shell user={user} title={r.title} back={{ href: "/reparations", label: "Réparations" }}>
      <Flash params={await searchParams} />
      <div className="card space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/vehicules/${r.vehicle_id}`} className="font-mono text-lg font-bold text-blue-700 underline">{r.plate}</Link>
          <span className="text-slate-600">{r.label}</span>
          <Badge tone={REPAIR_TONES[r.status]}>{REPAIR_STATUS_LABELS[r.status]}</Badge>
          {r.urgent && <Badge tone="red">Urgent</Badge>}
        </div>
        {r.description && <p className="text-sm">{r.description}</p>}
        <p className="muted">Créée le {fmtDate(r.created_at)} par {r.creator}{r.inspection_id && <> · <Link className="text-blue-700 underline" href={`/controles/${r.inspection_id}`}>voir le contrôle d&apos;origine</Link></>}</p>
        {r.validated_at && <p className="text-sm text-emerald-800">Dépense validée par {r.validator} le {fmtDateTime(r.validated_at)}</p>}
        {r.status_reason && ["refuse", "annule"].includes(r.status) && <p className="text-sm text-red-800">Motif : {r.status_reason}</p>}
        {r.status === "a_valider" && !can(user.role, "repair.validate") && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">En attente de validation par la direction.</p>}
      </div>

      {next.length > 0 && (
        <div className="card space-y-3">
          <h2 className="h2">Étape suivante</h2>
          <div className="grid gap-2">
            {forward.map((s) => (
              <form key={s} action={transitionRepair}>
                <input type="hidden" name="id" value={r.id} /><input type="hidden" name="to" value={s} /><input type="hidden" name="_back" value={back} />
                <button className={`${s === next[0] || s === "valide" ? "btn-primary" : "btn-secondary"} w-full`}>{ACTION_LABELS[s] ?? REPAIR_STATUS_LABELS[s]}</button>
              </form>
            ))}
          </div>
          {withReason.map((s) => (
            <details key={s}>
              <summary className="cursor-pointer text-sm font-medium text-red-700">{ACTION_LABELS[s]}…</summary>
              <form action={transitionRepair} className="mt-2 flex gap-2">
                <input type="hidden" name="id" value={r.id} /><input type="hidden" name="to" value={s} /><input type="hidden" name="_back" value={back} />
                <input name="reason" required className="input" placeholder="Motif (obligatoire)" />
                <button className="btn-danger shrink-0">Confirmer</button>
              </form>
            </details>
          ))}
          {next.includes("a_chiffrer") && r.status !== "refuse" && (
            <form action={transitionRepair}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="to" value="a_chiffrer" /><input type="hidden" name="_back" value={back} /><button className="text-sm text-slate-600 underline">Revenir à « À chiffrer »</button></form>
          )}
        </div>
      )}

      <form action={updateRepair} className="card space-y-3">
        <h2 className="h2">Détails</h2>
        <input type="hidden" name="id" value={r.id} /><input type="hidden" name="_back" value={back} />
        <fieldset disabled={!editable} className="space-y-3">
          <Field label="Objet"><input name="title" className="input" defaultValue={r.title} required /></Field>
          <Field label="Description"><textarea name="description" className="input" rows={2} defaultValue={r.description ?? ""} /></Field>
          <Field label="Garage"><input name="garage" className="input" defaultValue={r.garage ?? ""} /></Field>
          <label className="flex items-center gap-3"><input type="checkbox" name="urgent" className="h-6 w-6" defaultChecked={r.urgent} /> Urgent</label>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Coût estimé HT (€)"><input name="estimate_ht" className="input" inputMode="decimal" defaultValue={centsToInput(r.estimate_ht_cents)} readOnly={estimateLocked} /></Field>
            <Field label="Coût estimé TTC (€)"><input name="estimate_ttc" className="input" inputMode="decimal" defaultValue={centsToInput(r.estimate_ttc_cents)} readOnly={estimateLocked} /></Field>
            <Field label="Coût réel HT (€)"><input name="actual_ht" className="input" inputMode="decimal" defaultValue={centsToInput(r.actual_ht_cents)} /></Field>
            <Field label="Coût réel TTC (€)"><input name="actual_ttc" className="input" inputMode="decimal" defaultValue={centsToInput(r.actual_ttc_cents)} /></Field>
          </div>
          <p className="muted">Laissez vide si le montant n&apos;est pas connu : « non renseigné » n&apos;est pas « 0 € ».{estimateLocked && " Montant estimé verrouillé (soumis à validation ou validé)."}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Devis reçu le"><input type="date" name="quote_received_on" className="input" defaultValue={d(r.quote_received_on)} /></Field>
            <Field label="Planifié le"><input type="date" name="planned_on" className="input" defaultValue={d(r.planned_on)} /></Field>
            <Field label="Commencé le"><input type="date" name="started_on" className="input" defaultValue={d(r.started_on)} /></Field>
            <Field label="Terminé le"><input type="date" name="completed_on" className="input" defaultValue={d(r.completed_on)} /></Field>
          </div>
          {editable && <button className="btn-primary w-full">Enregistrer</button>}
        </fieldset>
        <p className="muted">Estimé : {fmtMoney(r.estimate_ht_cents)} HT · {fmtMoney(r.estimate_ttc_cents)} TTC — Réel : {fmtMoney(r.actual_ht_cents)} HT · {fmtMoney(r.actual_ttc_cents)} TTC</p>
      </form>

      <div className="card space-y-3">
        <h2 className="h2">Devis et factures</h2>
        {docs.length === 0 && <p className="muted">Aucun document.</p>}
        <ul className="divide-y divide-slate-100 text-sm">
          {docs.map((doc) => (
            <li key={doc.id} className="flex items-center justify-between gap-2 py-2">
              <a href={`/api/documents/${doc.id}`} target="_blank" rel="noreferrer" className="min-w-0 truncate text-blue-700 underline">{DOC_KIND_LABELS[doc.kind]} — {doc.filename}</a>
              <Badge tone={JOB_TONES[doc.job_status ?? "en_attente"]}>{JOB_LABELS[doc.job_status ?? "en_attente"].split(" —")[0]}</Badge>
            </li>
          ))}
        </ul>
        {can(user.role, "repair.edit") && (["devis", "facture"] as const).map((kind) => (
          <form key={kind} action={uploadRepairDocument} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={r.id} /><input type="hidden" name="kind" value={kind} /><input type="hidden" name="docId" value={randomUUID()} /><input type="hidden" name="_back" value={back} />
            <label className="min-w-0 flex-1"><span className="label">Ajouter {kind === "devis" ? "un devis" : "une facture"} (PDF ou photo, 4 Mo max)</span>
              <input type="file" name="file" required accept="application/pdf,image/jpeg,image/png" className="block w-full text-sm" /></label>
            <button className="btn-secondary btn-sm">Envoyer</button>
          </form>
        ))}
        <p className="muted">Les factures sont classées dans le sous-dossier Factures du véhicule, les devis à la racine de son dossier Drive.</p>
      </div>

      {can(user.role, "immobilization.propose") && (
        <details className="card">
          <summary className="cursor-pointer font-semibold text-red-700">Proposer l&apos;immobilisation du véhicule</summary>
          <form action={proposeImmobilization} className="mt-3 space-y-2">
            <input type="hidden" name="vehicleId" value={r.vehicle_id} /><input type="hidden" name="repairId" value={r.id} /><input type="hidden" name="_back" value={back} />
            <textarea name="reason" required className="input" rows={2} placeholder="Motif" />
            <button className="btn-danger w-full">Transmettre à la direction</button>
          </form>
        </details>
      )}

      {history.length > 0 && (
        <div className="card space-y-1 text-sm">
          <h2 className="h2">Historique</h2>
          {history.map((h, n) => <p key={n}>{fmtDateTime(h.at)} — {h.name ?? "—"} : {REPAIR_STATUS_LABELS[h.details.de]} → {REPAIR_STATUS_LABELS[h.details.vers]}{h.details.motif ? ` (${h.details.motif})` : ""}</p>)}
        </div>
      )}
    </Shell>
  );
}
