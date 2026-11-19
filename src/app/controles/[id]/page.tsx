import Link from "next/link";
import { notFound } from "next/navigation";
import { canAccessVehicle, requireUser } from "@/lib/auth";
import { q, q1 } from "@/lib/db";
import { can } from "@/lib/permissions";
import { Badge, Field, Flash, Shell } from "@/components/ui";
import { ANSWER_LABELS, PRIORITY_LABELS, SUMMARY_LABELS, type Answer, type Priority, type Summary } from "@/lib/checklist";
import { alertContact } from "@/lib/queries";
import { CallButton } from "@/app/controle/[vehicleId]/wizard";
import { SUMMARY_TONES } from "@/lib/labels";
import { fmtDateTime, fmtKm, fmtMoney } from "@/lib/format";
import { acknowledgeCritical, correctInspectionAction } from "@/app/actions";
import { SyncStatus } from "./sync-status";

const TONE: Record<Answer, "green" | "amber" | "red" | "gray"> = { bon: "green", a_surveiller: "amber", intervention: "red", urgent: "red", non_verifie: "gray", non_applicable: "gray" };

export default async function InspectionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const i = await q1<{ id: string; vehicle_id: string; author_id: string; performed_at: Date; mileage_km: number; previous_km: number | null; location: string | null; driver_name: string | null; driver_absent_reason: string | null; general_comment: string | null; critical_flag: boolean; critical_comment: string | null;
    critical_ack_at: Date | null; ack_name: string | null; summary: Summary; version: number; plate: string; label: string; author: string }>(
    `select i.*, v.plate, v.label, u.name as author, a.name as ack_name from inspections i join vehicles v on v.id = i.vehicle_id join users u on u.id = i.author_id left join users a on a.id = i.critical_ack_by where i.id = $1`, [id]);
  if (!i || !(await canAccessVehicle(user, i.vehicle_id))) notFound();
  const answers = await q<{ ref: number; group_label: string; item_label: string; essential: boolean; answer: Answer; measure: string | null; comment: string | null; priority: Priority | null; recommendation: string | null; estimate_ht_cents: number | null; garage: string | null }>(
    "select ref, group_label, item_label, essential, answer, measure, comment, priority, recommendation, estimate_ht_cents, garage from inspection_answers where inspection_id = $1 order by position", [id]);
  const docs = await q<{ id: string; kind: string; filename: string; version: number; sync_status: string; job_status: string | null; last_error: string | null }>(
    `select d.id, d.kind, d.filename, d.version, d.sync_status, j.status as job_status, j.last_error from documents d left join drive_jobs j on j.document_id = d.id where d.inspection_id = $1 order by d.kind desc, d.version, d.filename`, [id]);
  const corrections = await q<{ at: Date; name: string | null; details: { motif: string; avant: { km: number }; apres: { km: number } } }>(
    "select l.at, u.name, l.details from audit_log l left join users u on u.id = l.user_id where l.entity = 'inspection' and l.entity_id = $1 and l.action = 'correction' order by l.at", [id]);
  const repairs = await q<{ id: string; title: string }>("select r.id, r.title from repairs r join issues s on s.id = r.issue_id where s.inspection_id = $1 order by r.created_at", [id]);
  const immo = await q1<{ status: string; auto_rule: boolean; reason: string }>("select status, auto_rule, reason from immobilizations where inspection_id = $1", [id]);
  const signatures = await q<{ role: string; signer_name: string }>("select role, signer_name from inspection_signatures where inspection_id = $1 order by role desc", [id]);
  const contact = immo?.auto_rule ? await alertContact() : null;
  const canCorrect = can(user.role, "inspection.correct") && (user.role !== "technicien" || i.author_id === user.id);
  const notable = answers.filter((a) => a.answer !== "bon" && a.answer !== "non_applicable");
  return (
    <Shell user={user} title={`Contrôle ${i.plate}`} back={{ href: `/vehicules/${i.vehicle_id}`, label: `Fiche ${i.plate}` }}>
      <Flash params={sp.nouveau ? { ok: "Contrôle enregistré. Vous n'avez rien d'autre à saisir." } : sp} />
      {immo?.auto_rule && contact && (
        <div className="space-y-3 rounded-2xl border-2 border-red-600 bg-red-50 p-4">
          <h2 className="text-lg font-bold text-red-800">Véhicule déclaré immobilisé</h2>
          <p className="text-sm text-red-900">{immo.reason}. {immo.status === "active" ? `Prévenez ${contact.name} immédiatement par téléphone. Le véhicule ne doit pas rouler tant que la remise en circulation n'est pas autorisée.` : "Immobilisation levée depuis."}</p>
          {immo.status === "active" && <CallButton contact={contact} />}
        </div>
      )}
      <div className="card space-y-2">
        <p className="text-slate-700">{i.label} · {fmtDateTime(i.performed_at)} · {i.author}</p>
        <p className="muted">Lieu : {i.location ?? "non renseigné"} · Conducteur : {i.driver_name ?? "non renseigné"}{i.previous_km != null ? ` · ${fmtKm(i.mileage_km - i.previous_km)} depuis le dernier contrôle` : ""}</p>
        <p className="muted">Signatures : {signatures.map((sg) => `${sg.role === "controleur" ? "contrôleur" : "conducteur"} (${sg.signer_name})`).join(", ") || "aucune"}{i.driver_absent_reason ? ` · conducteur non signataire : ${i.driver_absent_reason}` : ""}</p>
        <p className="text-lg font-semibold">{fmtKm(i.mileage_km)} {i.version > 1 && <Badge tone="blue">version {i.version}</Badge>}</p>
        <Badge tone={SUMMARY_TONES[i.summary]}>{SUMMARY_LABELS[i.summary]}</Badge>
        {i.critical_flag && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            <b>Signalement :</b> {i.critical_comment}
            <div className="mt-1">{i.critical_ack_at ? `Pris en compte par ${i.ack_name} le ${fmtDateTime(i.critical_ack_at)}` : "En attente de prise en compte par la direction."}</div>
            {!i.critical_ack_at && can(user.role, "immobilization.decide") && (
              <form action={acknowledgeCritical} className="mt-2"><input type="hidden" name="id" value={i.id} /><input type="hidden" name="_back" value={`/controles/${i.id}`} /><button className="btn-danger btn-sm">Marquer comme pris en compte</button></form>
            )}
          </div>
        )}
        {i.general_comment && <p className="text-sm">Commentaire : {i.general_comment}</p>}
        <p className="muted">Ce contrôle consigne les constats du technicien. Il ne remplace pas les contrôles réglementaires et ne vaut pas attestation d&apos;aptitude.</p>
      </div>

      <SyncStatus inspectionId={i.id} initial={docs} canManage={can(user.role, "jobs.manage")} />

      {repairs.length > 0 && (
        <div className="card space-y-2">
          <h2 className="h2">Réparations ouvertes par ce contrôle</h2>
          {repairs.map((r) => <Link key={r.id} href={`/reparations/${r.id}`} className="block text-blue-700 underline">{r.title}</Link>)}
        </div>
      )}

      <div className="card space-y-2">
        <h2 className="h2">Points à retenir ({notable.length})</h2>
        {notable.length === 0 && <p className="muted">Tous les points vérifiés sont bons.</p>}
        {notable.map((a) => (
          <div key={a.item_label} className="border-b border-slate-100 py-2 last:border-0">
            <div className="flex items-start justify-between gap-2"><span className="text-sm font-medium">{a.ref}. {a.item_label}</span><Badge tone={TONE[a.answer]}>{ANSWER_LABELS[a.answer]}</Badge></div>
            <p className="muted">{[a.measure && `Mesure : ${a.measure}`, a.comment, a.priority && PRIORITY_LABELS[a.priority], a.recommendation && `Recommandation : ${a.recommendation}`, a.estimate_ht_cents != null && `estimé ${fmtMoney(a.estimate_ht_cents)} HT`, a.garage && `garage proposé : ${a.garage}`].filter(Boolean).join(" · ")}</p>
          </div>
        ))}
        <details className="pt-1 text-sm">
          <summary className="cursor-pointer font-medium text-blue-700">Voir les {answers.length} points</summary>
          <ul className="mt-2 space-y-1">{answers.map((a) => <li key={a.item_label} className="flex justify-between gap-2"><span>{a.ref}. {a.item_label}{a.measure ? ` (${a.measure})` : ""}</span><span className="shrink-0 text-slate-600">{ANSWER_LABELS[a.answer]}</span></li>)}</ul>
        </details>
      </div>

      {corrections.length > 0 && (
        <div className="card space-y-1 text-sm">
          <h2 className="h2">Corrections</h2>
          {corrections.map((c, n) => <p key={n}>{fmtDateTime(c.at)} — {c.name} : {c.details.motif} ({fmtKm(c.details.avant.km)} → {fmtKm(c.details.apres.km)})</p>)}
        </div>
      )}

      {canCorrect && (
        <details className="card">
          <summary className="cursor-pointer font-semibold">Corriger ce contrôle</summary>
          <form action={correctInspectionAction} className="mt-3 space-y-3">
            <input type="hidden" name="id" value={i.id} /><input type="hidden" name="_back" value={`/controles/${i.id}`} />
            <Field label="Kilométrage"><input name="mileageKm" className="input" inputMode="numeric" defaultValue={i.mileage_km} required /></Field>
            <Field label="Commentaire général"><textarea name="generalComment" className="input" rows={2} defaultValue={i.general_comment ?? ""} /></Field>
            <Field label="Motif de la correction (obligatoire)"><input name="reason" className="input" required minLength={3} /></Field>
            <p className="muted">La correction est tracée. Le rapport d&apos;origine est conservé ; un rapport « v{i.version + 1} » est ajouté. Les réponses aux points de contrôle ne se modifient pas : refaites un contrôle si nécessaire.</p>
            <button className="btn-primary w-full">Enregistrer la correction</button>
          </form>
        </details>
      )}
    </Shell>
  );
}
