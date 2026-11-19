"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ANSWER_LABELS, DELAYS, DELAY_LABELS, PRIORITIES, PRIORITY_LABELS, SUMMARY_LABELS, computeSummary, isAnomaly, validateAnswers,
  type Answer, type ChecklistGroup, type ChecklistItem, type Delay, type Priority } from "@/lib/checklist";
import { compressPhoto, deletePhoto, getPhoto, putPhoto } from "./photos";

type ItemState = { answer?: Answer; comment?: string; priority?: Priority; delay?: Delay; photoIds?: string[] };
type Draft = {
  inspectionId: string; plate: string; checklistVersion: string; step: number; mileage: string; answers: Record<string, ItemState>;
  generalComment: string; critical: boolean | null; criticalComment: string; proposeImmobilization: boolean; uploaded: string[]; savedAt: string;
};
type Props = { vehicle: { id: string; plate: string; label: string }; groups: ChecklistGroup[]; checklistVersion: string; nacelleMissing: boolean; lastKm: number | null; lastDate: string | null };

const ANSWER_STYLE: Record<Answer, string> = {
  bon: "border-emerald-600 bg-emerald-600 text-white", a_surveiller: "border-amber-500 bg-amber-500 text-white", intervention: "border-red-600 bg-red-600 text-white",
  non_verifie: "border-slate-600 bg-slate-600 text-white", non_applicable: "border-slate-600 bg-slate-600 text-white",
};
const newDraft = (p: Props): Draft => ({ inspectionId: crypto.randomUUID(), plate: p.vehicle.plate, checklistVersion: p.checklistVersion, step: 0, mileage: "", answers: {},
  generalComment: "", critical: null, criticalComment: "", proposeImmobilization: false, uploaded: [], savedAt: "" });

export function Wizard(props: Props) {
  const { vehicle, groups, lastKm } = props;
  const router = useRouter();
  const key = `gset:brouillon:${vehicle.id}`;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [storageOk, setStorageOk] = useState(true);
  const [online, setOnline] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);

  // Chargement du brouillon local (après hydratation : le serveur ne connaît pas le stockage du téléphone).
  useEffect(() => {
    let d: Draft | null = null, readable = true;
    try {
      const raw = localStorage.getItem(key);
      if (raw) d = JSON.parse(raw);
      if (d && d.checklistVersion !== props.checklistVersion) d = null; // questionnaire modifié : on repart d'une fiche propre
    } catch { readable = false; }
    /* eslint-disable react-hooks/set-state-in-effect -- lecture du stockage local après hydratation */
    setStorageOk(readable);
    setDraft(d ?? newDraft(props));
    setOnline(navigator.onLine);
    /* eslint-enable react-hooks/set-state-in-effect */
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = useCallback((patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) => {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, ...(typeof patch === "function" ? patch(d) : patch), savedAt: new Date().toISOString() };
      try { localStorage.setItem(key, JSON.stringify(next)); setStorageOk(true); } catch { setStorageOk(false); }
      return next;
    });
  }, [key]);
  const setItem = (code: string, patch: Partial<ItemState>) => { if (errors.length) setErrors([]); update((d) => ({ answers: { ...d.answers, [code]: { ...d.answers[code], ...patch } } })); };

  const totalSteps = groups.length + 2; // kilométrage + groupes + récapitulatif
  const goto = (step: number) => { setErrors([]); setFailure(null); update({ step }); top.current?.scrollIntoView({ behavior: "smooth" }); };

  const answerList = useMemo(() => !draft ? [] : groups.flatMap((g) => g.items).filter((i) => draft.answers[i.code]?.answer).map((i) => {
    const s = draft.answers[i.code];
    return { itemCode: i.code, answer: s.answer!, comment: s.comment ?? null, priority: isAnomaly(s.answer!) ? s.priority ?? null : null, delay: s.answer === "intervention" ? s.delay ?? null : null, photoIds: isAnomaly(s.answer!) ? s.photoIds ?? [] : [] };
  }), [draft, groups]);

  if (!draft) return <p className="muted">Chargement…</p>;
  const step = Math.min(draft.step, totalSteps - 1);
  const km = /^\d{1,7}$/.test(draft.mileage.trim()) ? Number(draft.mileage.trim()) : null;

  function next() {
    if (step === 0) {
      if (km === null) return setErrors(["Saisissez le kilométrage affiché au compteur (chiffres uniquement)."]);
      return goto(1);
    }
    const group = groups[step - 1];
    const errs = validateAnswers([group], answerList.filter((a) => group.items.some((i) => i.code === a.itemCode)));
    if (errs.length) { setErrors(errs); top.current?.scrollIntoView({ behavior: "smooth" }); return; }
    goto(step + 1);
  }

  async function submit(mileageLowerConfirmed = false, retried = false): Promise<void> {
    if (!draft || km === null) return;
    const errs = validateAnswers(groups, answerList);
    if (draft.critical === null) errs.push("Indiquez si vous signalez un problème critique (Oui ou Non).");
    if (draft.critical && !draft.criticalComment.trim()) errs.push("Décrivez le problème critique.");
    if (errs.length) return setErrors(errs);
    setErrors([]); setFailure(null);
    try {
      // 1. Photos : envoyées une à une, chacune rejouable sans doublon.
      const photoIds = answerList.flatMap((a) => a.photoIds);
      let uploaded = draft.uploaded;
      let n = 0;
      for (const id of photoIds) {
        n++;
        if (uploaded.includes(id)) continue;
        setBusy(`Envoi de la photo ${n}/${photoIds.length}…`);
        const blob = await getPhoto(id);
        if (!blob) { setBusy(null); return setFailure("Une photo du brouillon est introuvable sur ce téléphone. Supprimez-la du point concerné et reprenez-la."); }
        const form = new FormData();
        form.set("id", id); form.set("file", new File([blob], `${id}.jpg`, { type: "image/jpeg" }));
        const res = await fetch("/api/uploads", { method: "POST", body: form });
        if (!res.ok) { setBusy(null); return setFailure((await res.json().catch(() => null))?.error ?? "L'envoi d'une photo a échoué. Réessayez."); }
        uploaded = [...uploaded, id];
        update({ uploaded });
      }
      // 2. Contrôle : un seul enregistrement, identifié par l'identifiant du brouillon.
      setBusy("Enregistrement du contrôle…");
      const res = await fetch("/api/inspections", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: draft.inspectionId, vehicleId: vehicle.id, mileageKm: km, mileageLowerConfirmed, generalComment: draft.generalComment, criticalFlag: draft.critical,
          criticalComment: draft.criticalComment, proposeImmobilization: !!draft.critical && draft.proposeImmobilization, answers: answerList }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok) {
        for (const id of photoIds) await deletePhoto(id).catch(() => {});
        try { localStorage.removeItem(key); } catch {}
        router.push(`/controles/${draft.inspectionId}?nouveau=1`);
        return;
      }
      setBusy(null);
      if (res.status === 401) return setFailure("Votre session a expiré. Le brouillon est conservé : reconnectez-vous dans un autre onglet puis validez à nouveau.");
      if (json?.details?.code === "kilometrage_inferieur" && !mileageLowerConfirmed) {
        if (window.confirm(`${json.error}\n\nConfirmer ${km} km ?`)) return submit(true, retried);
        return goto(0);
      }
      if (json?.details?.code === "photos_manquantes" && !retried) {
        const missing: string[] = json.details.manquantes ?? [];
        draft.uploaded = uploaded.filter((id) => !missing.includes(id)); // à renvoyer
        update({ uploaded: draft.uploaded });
        return submit(mileageLowerConfirmed, true);
      }
      if (Array.isArray(json?.details)) setErrors(json.details);
      setFailure(json?.error ?? "L'enregistrement a échoué. Le brouillon est conservé, réessayez.");
    } catch {
      setBusy(null);
      setFailure("Pas de connexion : le contrôle n'est PAS encore enregistré. Votre brouillon reste sur ce téléphone. Gardez cette page ouverte et validez à nouveau quand le réseau revient.");
    }
  }

  const summary = computeSummary(groups, answerList, !!draft.critical);
  const anomalies = groups.flatMap((g) => g.items.map((i) => ({ g, i, s: draft.answers[i.code] }))).filter((x) => x.s?.answer && isAnomaly(x.s.answer));
  const essentialMissing = groups.flatMap((g) => g.items).filter((i) => i.essential && draft.answers[i.code]?.answer === "non_verifie");

  return (
    <div className="space-y-4" ref={top}>
      <div>
        <div className="mb-1 flex justify-between text-sm text-slate-600">
          <span>{vehicle.label}</span>
          <span>Étape {step + 1}/{totalSteps}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-blue-700 transition-all" style={{ width: `${((step + 1) / totalSteps) * 100}%` }} /></div>
      </div>

      {!online && <p className="rounded-xl bg-slate-800 px-4 py-2 text-sm text-white">Hors connexion : vous pouvez continuer à remplir, le brouillon reste sur ce téléphone. La validation demandera du réseau.</p>}
      {!storageOk && <p className="rounded-xl border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800">Ce navigateur refuse l&apos;enregistrement local (navigation privée ?) : le brouillon sera perdu si la page est fermée.</p>}
      {errors.length > 0 && (
        <ul className="list-disc space-y-1 rounded-xl border border-red-300 bg-red-50 py-3 pl-8 pr-4 text-sm font-medium text-red-800">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
      )}

      {step === 0 && (
        <div className="card space-y-3">
          <h2 className="h2">Kilométrage</h2>
          <p className="muted">{lastKm != null ? `Dernier relevé : ${lastKm.toLocaleString("fr-FR")} km${props.lastDate ? ` (contrôle du ${props.lastDate})` : ""}` : "Premier contrôle de ce véhicule dans l'application."}</p>
          <input className="input text-2xl font-bold" inputMode="numeric" pattern="[0-9]*" placeholder="ex. 125400" value={draft.mileage} onChange={(e) => update({ mileage: e.target.value.replace(/\D/g, "").slice(0, 7) })} aria-label="Kilométrage" />
          {km !== null && lastKm != null && km < lastKm && <p className="text-sm font-medium text-amber-700">Inférieur au dernier relevé : une confirmation sera demandée à la validation.</p>}
          <p className="muted">La date et votre nom sont enregistrés automatiquement à la validation.</p>
          {props.nacelleMissing && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Véhicule nacelle : les points spécifiques à la nacelle ne sont pas encore dans ce questionnaire (fiche métier en attente de validation). Ce contrôle ne couvre que le porteur.</p>}
        </div>
      )}

      {step >= 1 && step <= groups.length && (
        <div className="space-y-3">
          <h2 className="h2">{groups[step - 1].label}</h2>
          {groups[step - 1].items.map((item) => <ItemCard key={item.code} item={item} state={draft.answers[item.code] ?? {}} onChange={(p) => setItem(item.code, p)} />)}
        </div>
      )}

      {step === totalSteps - 1 && (
        <div className="space-y-3">
          <div className="card space-y-2">
            <h2 className="h2">Récapitulatif</h2>
            <p><span className="font-mono font-bold">{vehicle.plate}</span> · {km?.toLocaleString("fr-FR")} km</p>
            <p className="font-semibold">{SUMMARY_LABELS[summary]}</p>
            <p className="muted">
              {(["bon", "a_surveiller", "intervention", "non_verifie", "non_applicable"] as Answer[]).map((a) => `${ANSWER_LABELS[a]} : ${answerList.filter((x) => x.answer === a).length}`).join(" · ")}
            </p>
            {anomalies.length > 0 && (
              <ul className="space-y-1 text-sm">
                {anomalies.map(({ g, i, s }) => (
                  <li key={i.code} className={s!.answer === "intervention" ? "text-red-700" : "text-amber-700"}>
                    <b>{ANSWER_LABELS[s!.answer!]}</b> — {g.label} : {i.label}{s!.comment ? ` (${s!.comment})` : ""}{s!.photoIds?.length ? ` · ${s!.photoIds.length} photo(s)` : ""}
                  </li>
                ))}
              </ul>
            )}
            {essentialMissing.length > 0 && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><b>Contrôles essentiels non vérifiés :</b> {essentialMissing.map((i) => i.label).join(" ; ")}. Le contrôle sera enregistré comme incomplet.</p>}
          </div>

          <div className="card space-y-3">
            <h2 className="h2">Signalez-vous un problème critique ?</h2>
            <p className="muted">Un problème qui, selon vous, rend l&apos;utilisation du véhicule dangereuse. La direction est alertée.</p>
            <div className="grid grid-cols-2 gap-3">
              <button type="button" onClick={() => update({ critical: true })} className={`btn border-2 ${draft.critical === true ? "border-red-600 bg-red-600 text-white" : "border-slate-300 bg-white"}`}>Oui</button>
              <button type="button" onClick={() => update({ critical: false, proposeImmobilization: false })} className={`btn border-2 ${draft.critical === false ? "border-slate-700 bg-slate-700 text-white" : "border-slate-300 bg-white"}`}>Non</button>
            </div>
            {draft.critical && (
              <>
                <textarea className="input" rows={3} placeholder="Décrivez le problème critique" value={draft.criticalComment} onChange={(e) => update({ criticalComment: e.target.value })} />
                <label className="flex items-center gap-3 text-base">
                  <input type="checkbox" className="h-6 w-6" checked={draft.proposeImmobilization} onChange={(e) => update({ proposeImmobilization: e.target.checked })} />
                  Proposer l&apos;immobilisation du véhicule (la direction décide)
                </label>
              </>
            )}
          </div>

          <div className="card space-y-2">
            <label className="label" htmlFor="gc">Commentaire général (facultatif)</label>
            <textarea id="gc" className="input" rows={2} value={draft.generalComment} onChange={(e) => update({ generalComment: e.target.value })} />
          </div>

          <div className="card space-y-1 text-sm">
            <p><b>Brouillon local :</b> {storageOk ? `conservé sur ce téléphone${draft.savedAt ? ` (${new Date(draft.savedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })})` : ""}` : "non conservé"}</p>
            <p><b>Contrôle enregistré :</b> non — appuyez sur « Valider le contrôle »</p>
            <p><b>Documents déposés sur Drive :</b> après l&apos;enregistrement</p>
          </div>
          <p className="muted">Ce contrôle consigne vos constats. Il ne remplace pas les contrôles réglementaires et ne vaut pas attestation d&apos;aptitude du véhicule.</p>
          {failure && <p role="alert" className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">{failure}</p>}
          <button type="button" disabled={!!busy} onClick={() => submit()} className="btn-primary min-h-16 w-full text-xl">{busy ?? "Valider le contrôle"}</button>
        </div>
      )}

      <div className="flex gap-3">
        {step > 0 && <button type="button" disabled={!!busy} onClick={() => goto(step - 1)} className="btn-secondary flex-1">Précédent</button>}
        {step < totalSteps - 1 && <button type="button" onClick={next} className="btn-primary flex-[2] min-h-14 text-lg">Suivant</button>}
      </div>
      {step === 0 && draft.savedAt && (
        <button type="button" className="text-sm text-slate-500 underline" onClick={() => {
          if (!window.confirm("Effacer ce brouillon et recommencer ?")) return;
          for (const s of Object.values(draft.answers)) for (const id of s.photoIds ?? []) deletePhoto(id).catch(() => {});
          try { localStorage.removeItem(key); } catch {}
          setDraft(newDraft(props));
        }}>Effacer le brouillon et recommencer</button>
      )}
    </div>
  );
}

function ItemCard({ item, state, onChange }: { item: ChecklistItem; state: ItemState; onChange: (p: Partial<ItemState>) => void }) {
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const a = state.answer;
  const pick = (answer: Answer) => onChange({ answer, ...(isAnomaly(answer) && !state.priority ? { priority: answer === "intervention" ? "haute" : "normale" } : {}) });
  const btn = (answer: Answer, small = false) => (
    <button key={answer} type="button" aria-pressed={a === answer} onClick={() => pick(answer)}
      className={`rounded-xl border-2 px-2 font-semibold leading-tight ${small ? "min-h-10 text-sm" : "min-h-14 text-base"} ${a === answer ? ANSWER_STYLE[answer] : "border-slate-300 bg-white text-slate-800"}`}>
      {ANSWER_LABELS[answer]}
    </button>
  );
  async function addPhoto(file: File | undefined) {
    if (!file) return;
    setPhotoError(null); setAdding(true);
    try {
      const blob = await compressPhoto(file);
      const id = crypto.randomUUID();
      await putPhoto(id, blob);
      onChange({ photoIds: [...(state.photoIds ?? []), id] });
    } catch { setPhotoError("Photo illisible ou stockage du téléphone plein. Réessayez."); }
    setAdding(false);
  }
  const photoNeeded = a === "intervention" && item.photoRequired;
  return (
    <div className="card space-y-3">
      <p className="text-base font-semibold">{item.label}{item.essential && <span className="ml-2 text-xs font-normal text-slate-500">essentiel</span>}</p>
      <div className="grid grid-cols-3 gap-2">{(["bon", "a_surveiller", "intervention"] as Answer[]).map((x) => btn(x))}</div>
      <div className="grid grid-cols-2 gap-2">{(["non_verifie", "non_applicable"] as Answer[]).map((x) => btn(x, true))}</div>

      {a && (isAnomaly(a) || a === "non_verifie" || (a === "non_applicable" && item.essential)) && (
        <textarea className="input" rows={2} value={state.comment ?? ""} onChange={(e) => onChange({ comment: e.target.value })}
          placeholder={isAnomaly(a) ? "Que constatez-vous ?" : a === "non_verifie" ? "Pourquoi ce point n'a pas été vérifié ?" : "Pourquoi non applicable ?"} />
      )}
      {a && isAnomaly(a) && (
        <>
          <div>
            <span className="label">Priorité</span>
            <div className="grid grid-cols-4 gap-2">
              {PRIORITIES.map((p) => <button key={p} type="button" onClick={() => onChange({ priority: p })} className={`min-h-10 rounded-lg border-2 text-sm font-semibold ${state.priority === p ? "border-blue-700 bg-blue-700 text-white" : "border-slate-300 bg-white"}`}>{PRIORITY_LABELS[p]}</button>)}
            </div>
          </div>
          {a === "intervention" && (
            <div>
              <span className="label">Délai proposé</span>
              <div className="grid grid-cols-2 gap-2">
                {DELAYS.map((d) => <button key={d} type="button" onClick={() => onChange({ delay: d })} className={`min-h-10 rounded-lg border-2 text-sm font-semibold ${state.delay === d ? "border-blue-700 bg-blue-700 text-white" : "border-slate-300 bg-white"}`}>{DELAY_LABELS[d]}</button>)}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">{(state.photoIds ?? []).map((id) => <Thumb key={id} id={id} onRemove={() => { deletePhoto(id).catch(() => {}); onChange({ photoIds: (state.photoIds ?? []).filter((x) => x !== id) }); }} />)}</div>
            {(state.photoIds?.length ?? 0) < 4 && (
              <label className={`btn-secondary w-full cursor-pointer ${photoNeeded && !state.photoIds?.length ? "border-red-400" : ""}`}>
                {adding ? "Préparation…" : state.photoIds?.length ? "Ajouter une autre photo" : `Ajouter une photo${photoNeeded ? " (requise)" : " (facultative)"}`}
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { addPhoto(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
            )}
            {photoError && <p className="text-sm text-red-700">{photoError}</p>}
          </div>
        </>
      )}
    </div>
  );
}

function Thumb({ id, onRemove }: { id: string; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null, alive = true;
    getPhoto(id).then((b) => { if (b && alive) { u = URL.createObjectURL(b); setUrl(u); } }).catch(() => {});
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [id]);
  return (
    <div className="relative h-20 w-20 overflow-hidden rounded-lg border border-slate-300 bg-slate-100">
      {/* eslint-disable-next-line @next/next/no-img-element -- aperçu d'une photo locale (blob) */}
      {url && <img src={url} alt="Photo du constat" className="h-full w-full object-cover" />}
      <button type="button" onClick={onRemove} aria-label="Supprimer la photo" className="absolute right-0 top-0 h-7 w-7 rounded-bl-lg bg-black/70 text-white">×</button>
    </div>
  );
}
