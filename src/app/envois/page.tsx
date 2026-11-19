import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { q } from "@/lib/db";
import { Badge, Empty, Flash, Shell } from "@/components/ui";
import { driveMode } from "@/lib/drive";
import { DOC_KIND_LABELS, JOB_LABELS, JOB_TONES } from "@/lib/labels";
import { fmtDateTime } from "@/lib/format";
import { retryJobAction } from "@/app/actions";

type Row = { id: string; status: string; attempts: number; max_attempts: number; next_attempt_at: Date; last_error: string | null; created_at: Date; finished_at: Date | null;
  document_id: string; kind: string; filename: string; plate: string; vehicle_id: string; inspection_id: string | null; repair_id: string | null };

export default async function Jobs({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requirePermission("jobs.manage");
  const select = `select j.*, d.kind, d.filename, d.inspection_id, d.repair_id, d.vehicle_id, v.plate from drive_jobs j join documents d on d.id = j.document_id join vehicles v on v.id = d.vehicle_id`;
  const [open, recent] = await Promise.all([
    q<Row>(`${select} where j.status <> 'termine' order by j.created_at limit 200`),
    q<Row>(`${select} where j.status = 'termine' order by j.finished_at desc limit 30`),
  ]);
  let mode: string;
  try { mode = driveMode(); } catch (e) { mode = (e as Error).message; }
  const MODES: Record<string, string> = { none: "Drive non configuré : les documents restent en attente, rien n'est perdu.", mock: "Simulateur Drive (développement) : aucun fichier n'est envoyé vers Google Drive.", service_account: "Identité de service Google.", oauth: "Compte Google autorisé (OAuth)." };
  const origin = (r: Row) => r.inspection_id ? `/controles/${r.inspection_id}` : r.repair_id ? `/reparations/${r.repair_id}` : `/vehicules/${r.vehicle_id}`;
  return (
    <Shell user={user} title="Envois vers Drive" wide>
      <Flash params={await searchParams} />
      <p className={`rounded-xl border px-4 py-3 text-sm ${mode === "service_account" || mode === "oauth" ? "border-slate-200 bg-white" : "border-amber-300 bg-amber-50 text-amber-900"}`}>Connexion Drive : {MODES[mode] ?? mode}</p>
      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="h2">Documents en attente ({open.length})</h2>
          {open.length > 0 && <form action={retryJobAction}><input type="hidden" name="_back" value="/envois" /><button className="btn-primary btn-sm">Tout relancer maintenant</button></form>}
        </div>
        {open.length === 0 ? <Empty>Tous les documents sont déposés sur Drive.</Empty> : (
          <div className="overflow-x-auto"><table className="table"><thead><tr><th>Véhicule</th><th>Document</th><th>État</th><th>Tentatives</th><th>Prochaine tentative</th><th>Dernière erreur</th><th /></tr></thead><tbody>
            {open.map((r) => (
              <tr key={r.id}>
                <td className="font-mono font-semibold">{r.plate}</td>
                <td><Link href={origin(r)} className="text-blue-700 underline">{DOC_KIND_LABELS[r.kind]}</Link><div className="muted break-all">{r.filename}</div></td>
                <td><Badge tone={JOB_TONES[r.status]}>{JOB_LABELS[r.status]}</Badge></td>
                <td>{r.attempts}/{r.max_attempts}</td>
                <td>{r.status === "echec" ? "—" : fmtDateTime(r.next_attempt_at)}</td>
                <td className="max-w-xs text-red-800">{r.last_error ?? "—"}</td>
                <td><form action={retryJobAction}><input type="hidden" name="_back" value="/envois" /><input type="hidden" name="id" value={r.id} /><button className="btn-secondary btn-sm">Relancer</button></form></td>
              </tr>
            ))}
          </tbody></table></div>
        )}
        <p className="muted">Les envois sont retentés automatiquement avec des délais croissants (1 min, 2, 4… jusqu&apos;à 6 h). « Bloqué » signale un problème d&apos;accès ou de configuration à corriger (dossier non vérifié, droit manquant) : il est revérifié toutes les 15 minutes. Une relance ne crée jamais de doublon.</p>
      </section>
      <section className="card space-y-2">
        <h2 className="h2">Derniers dépôts réussis</h2>
        {recent.length === 0 ? <Empty>Aucun dépôt pour l&apos;instant.</Empty> : recent.map((r) => (
          <div key={r.id} className="flex flex-wrap gap-2 text-sm"><span className="font-mono font-semibold">{r.plate}</span><a href={`/api/documents/${r.document_id}`} target="_blank" rel="noreferrer" className="break-all text-blue-700 underline">{r.filename}</a><span className="muted">{fmtDateTime(r.finished_at)}</span></div>
        ))}
      </section>
    </Shell>
  );
}
