"use client";
import { useEffect, useState } from "react";

type Doc = { id: string; kind: string; filename: string; version: number; sync_status: string; job_status: string | null; last_error: string | null };
const KIND: Record<string, string> = { rapport_controle: "Rapport", photo: "Photo" };

/** Suivi du dépôt Drive, rafraîchi automatiquement tant que des documents sont en attente. */
export function SyncStatus({ inspectionId, initial, canManage }: { inspectionId: string; initial: Doc[]; canManage: boolean }) {
  const [docs, setDocs] = useState(initial);
  const pending = docs.some((d) => d.sync_status !== "depose");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/inspections/${inspectionId}/status`);
        if (res.ok) setDocs((await res.json()).documents);
      } catch {}
    }, 5000);
    return () => clearInterval(t);
  }, [inspectionId, pending]);
  const done = docs.filter((d) => d.sync_status === "depose").length;
  const problem = docs.some((d) => d.job_status === "bloque" || d.job_status === "echec");
  return (
    <div className="card space-y-3">
      <ul className="space-y-1 text-base">
        <li>✅ <b>Contrôle enregistré</b> dans le suivi</li>
        <li>{done === docs.length ? "✅" : problem ? "⚠️" : "⏳"} <b>Documents déposés sur Drive :</b> {done}/{docs.length}{done < docs.length && !problem ? " — envoi en cours, rien à refaire" : ""}</li>
      </ul>
      {problem && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Le dépôt sur Drive est en attente d&apos;une action {canManage ? "(voir « Envois Drive »)" : "de l'administrateur"}. Le contrôle est bien enregistré : ne le ressaisissez pas.</p>}
      <ul className="divide-y divide-slate-100 text-sm">
        {docs.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 py-2">
            <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer" className="min-w-0 truncate text-blue-700 underline">{KIND[d.kind] ?? d.kind}{d.version > 1 ? ` v${d.version}` : ""} — {d.filename}</a>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${d.sync_status === "depose" ? "bg-emerald-100 text-emerald-800" : d.job_status === "bloque" || d.job_status === "echec" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900"}`}>
              {d.sync_status === "depose" ? "Sur Drive" : d.job_status === "bloque" ? "Bloqué" : d.job_status === "echec" ? "Échec" : "En attente"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
