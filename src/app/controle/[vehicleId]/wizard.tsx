"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ANSWERS, ANSWER_LABELS, PRIORITIES, PRIORITY_LABELS, SAFETY_LABELS, SUMMARY_LABELS, computeSummary, isAnomaly, needsRepair, safetyFailures, validateAnswers,
  type Answer, type ChecklistGroup, type ChecklistItem, type Priority } from "@/lib/checklist";
import { parseMoney } from "@/lib/format";
import { compressPhoto, deletePhoto, getPhoto, putPhoto } from "./photos";
import { SignaturePad } from "./signature-pad";

type ItemState = { answer?: Answer; measure?: string; comment?: string; priority?: Priority; recommendation?: string; estimate?: string; garage?: string; photoIds?: string[] };
type Draft = {
  inspectionId: string; plate: string; checklistVersion: string; step: number; mileage: string; location: string; answers: Record<string, ItemState>;
  generalComment: string; critical: boolean | null; criticalComment: string; proposeImmobilization: boolean; uploaded: string[]; savedAt: string;
  controllerSignature: string | null; driverName: string; driverSignature: string | null; driverAbsent: boolean; driverAbsentReason: string;
};
export type AlertContact = { name: string; phone: string | null };
type Props = { vehicle: { id: string; plate: string; label: string; site: string | null; assignment: string | null }; contact: AlertContact; planningNote: string | null; groups: ChecklistGroup[]; checklistVersion: string; nacelleMissing: boolean; lastKm: number | null; lastDate: string | null };

const ANSWER_STYLE: Record<Answer, string> = {
  bon: "border-emerald-600 bg-emerald-600 text-white", a_surveiller: "border-amber-500 bg-amber-500 text-white", intervention: "border-orange-600 bg-orange-600 text-white", urgent: "border-red-700 bg-red-700 text-white",
  non_verifie: "border-slate-600 bg-slate-600 text-white", non_applicable: "border-slate-600 bg-slate-600 text-white",
};
const newDraft = (p: Props): Draft => ({ inspectionId: crypto.randomUUID(), plate: p.vehicle.plate, checklistVersion: p.checklistVersion, step: 0, mileage: "", location: p.vehicle.site ?? "", answers: {},
  generalComment: "", critical: null, criticalComment: "", proposeImmobilization: false, uploaded: [], savedAt: "",
  controllerSignature: null, driverName: p.vehicle.assignment ?? "", driverSignature: null, driverAbsent: false, driverAbsentReason: "" });

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
    setErrors((e) => (e.length ? [] : e)); // toute saisie efface les messages d'erreur affichés
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, ...(typeof patch === "function" ? patch(d) : patch), savedAt: new Date().toISOString() };
      try { localStorage.setItem(key, JSON.stringify(next)); setStorageOk(true); } catch { setStorageOk(false); }
      return next;
    });
  }, [key]);
  const setItem = (code: string, patch: Partial<ItemState>) => { update((d) => ({ answers: { ...d.answers, [code]: { ...d.answers[code], ...patch } } })); };

  const totalSteps = groups.length + 2; // kilométrage + groupes + récapitulatif
  const goto = (step: number) => { setErrors([]); setFailure(null); update({ step }); top.current?.scrollIntoView({ behavior: "smooth" }); };

  const answerList = useMemo(() => !draft ? [] : groups.flatMap((g) => g.items).filter((i) => draft.answers[i.code]?.answer).map((i) => {
    const s = draft.answers[i.code], a = s.answer!, repair = needsRepair(a);
    return { itemCode: i.code, answer: a, measure: s.measure?.trim() || null, comment: s.comment?.trim() || null, priority: a === "urgent" ? "urgent" as Priority : a === "intervention" ? s.priority ?? null : null,
      recommendation: repair ? s.recommendation?.trim() || null : null, estimateHtCents: repair ? parseMoney(s.estimate) ?? null : null, garage: repair ? s.garage?.trim() || null : null, photoIds: isAnomaly(a) ? s.photoIds ?? [] : [] };
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
    const hasUrgent = answerList.some((a) => a.answer === "urgent");
    if (draft.critical === null && !hasUrgent) errs.push("Indiquez si vous signalez un problème critique (Oui ou Non).");
    if (draft.critical && !draft.criticalComment.trim()) errs.push("Décrivez le problème critique.");
    for (const [code, st] of Object.entries(draft.answers)) if (st.answer && needsRepair(st.answer) && parseMoney(st.estimate) === undefined) errs.push(`Coût estimé invalide (point ${groups.flatMap((g) => g.items).find((i) => i.code === code)?.ref}).`);
    if (!draft.controllerSignature) errs.push("Votre signature (contrôleur) est requise.");
    if (draft.driverAbsent ? !draft.driverAbsentReason.trim() : !draft.driverSignature) errs.push("Faites signer le conducteur, ou cochez « Le conducteur ne signe pas » et indiquez pourquoi.");
    if (!draft.driverAbsent && draft.driverSignature && !draft.driverName.trim()) errs.push("Indiquez le nom du conducteur qui signe.");
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
        body: JSON.stringify({ id: draft.inspectionId, vehicleId: vehicle.id, mileageKm: km, mileageLowerConfirmed, location: draft.location, generalComment: draft.generalComment, criticalFlag: !!draft.critical,
          criticalComment: draft.critical ? draft.criticalComment : null, proposeImmobilization: draft.proposeImmobilization, controllerSignature: draft.controllerSignature,
          driverName: draft.driverName, driverSignature: draft.driverAbsent ? null : draft.driverSignature, driverAbsentReason: draft.driverAbsent ? draft.driverAbsentReason : null, answers: answerList }),
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
  const failures = safetyFailures(groups, answerList);
  const hasUrgent = answerList.some((a) => a.answer === "urgent");
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
          <label className="block"><span className="label">Lieu du contrôle</span><input className="input" value={draft.location} onChange={(e) => update({ location: e.target.value.slice(0, 200) })} placeholder="ex. Cayenne, dépôt" /></label>
          <p className="muted">Conducteur affecté : {vehicle.assignment ?? "non renseigné"}.{props.planningNote ? ` ${props.planningNote}` : ""}</p>
          <p className="muted">Contrôle à l&apos;arrêt, sur sol plat, moteur froid pour les niveaux (≈ 45 min). La date et votre nom sont enregistrés automatiquement à la validation.</p>
          {props.nacelleMissing && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Véhicule nacelle : les points spécifiques à la nacelle ne sont pas encore dans ce questionnaire (fiche métier en attente de validation). Ce contrôle ne couvre que le porteur.</p>}
        </div>
      )}

      {step >= 1 && step <= groups.length && (
        <div className="space-y-3">
          <h2 className="h2">{groups[step - 1].label}{groups[step - 1].hint && <span className="ml-2 text-sm font-normal text-slate-500">({groups[step - 1].hint})</span>}</h2>
          {groups[step - 1].items.map((item) => <ItemCard key={item.code} item={item} contact={props.contact} state={draft.answers[item.code] ?? {}} onChange={(p) => setItem(item.code, p)} />)}
        </div>
      )}

      {step === totalSteps - 1 && (
        <div className="space-y-3">
          <div className="card space-y-2">
            <h2 className="h2">Récapitulatif</h2>
            <p><span className="font-mono font-bold">{vehicle.plate}</span> · {km?.toLocaleString("fr-FR")} km</p>
            <p className="font-semibold">{SUMMARY_LABELS[summary]}</p>
            <p className="muted">
              {ANSWERS.map((a) => `${ANSWER_LABELS[a]} : ${answerList.filter((x) => x.answer === a).length}`).join(" · ")}
            </p>
            {anomalies.length > 0 && (
              <ul className="space-y-1 text-sm">
                {anomalies.map(({ i, s }) => (
                  <li key={i.code} className={s!.answer === "urgent" ? "text-red-700" : s!.answer === "intervention" ? "text-orange-700" : "text-amber-700"}>
                    <b>{ANSWER_LABELS[s!.answer!]}</b> — {i.ref}. {i.label}{s!.comment ? ` (${s!.comment})` : ""}{s!.photoIds?.length ? ` · ${s!.photoIds.length} photo(s)` : ""}
                  </li>
                ))}
              </ul>
            )}
            {essentialMissing.length > 0 && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><b>Contrôles essentiels non vérifiés :</b> {essentialMissing.map((i) => i.label).join(" ; ")}. Le contrôle sera enregistré comme incomplet.</p>}
          </div>

          {failures.length > 0 && (
            <div className="space-y-3 rounded-2xl border-2 border-red-600 bg-red-50 p-4">
              <h2 className="text-lg font-bold text-red-800">Véhicule à immobiliser</h2>
              <p className="text-sm text-red-900">Défaillance de sécurité ({[...new Set(failures.map((f) => SAFETY_LABELS[f.domain]))].join(", ")}) : à la validation, le véhicule sera déclaré <b>Immobilisé</b>. Prévenez {props.contact.name} immédiatement par téléphone.</p>
              <CallButton contact={props.contact} />
            </div>
          )}

          <div className="card space-y-3">
            <h2 className="h2">{hasUrgent ? "Un autre problème critique à signaler ?" : "Signalez-vous un problème critique ?"}</h2>
            <p className="muted">{hasUrgent ? "Les points « Urgent » sont déjà signalés à la direction." : "Un problème qui, selon vous, rend l'utilisation du véhicule dangereuse. La direction est alertée."}</p>
            <div className="grid grid-cols-2 gap-3">
              <button type="button" onClick={() => update({ critical: true })} className={`btn border-2 ${draft.critical === true ? "border-red-600 bg-red-600 text-white" : "border-slate-300 bg-white"}`}>Oui</button>
              <button type="button" onClick={() => update({ critical: false })} className={`btn border-2 ${draft.critical === false ? "border-slate-700 bg-slate-700 text-white" : "border-slate-300 bg-white"}`}>Non</button>
            </div>
            {draft.critical && <textarea className="input" rows={3} placeholder="Décrivez le problème critique" value={draft.criticalComment} onChange={(e) => update({ criticalComment: e.target.value })} />}
            {(draft.critical || hasUrgent) && failures.length === 0 && (
              <label className="flex items-center gap-3 text-base">
                <input type="checkbox" className="h-6 w-6" checked={draft.proposeImmobilization} onChange={(e) => update({ proposeImmobilization: e.target.checked })} />
                Proposer l&apos;immobilisation du véhicule (la direction décide)
              </label>
            )}
          </div>

          <div className="card space-y-4">
            <h2 className="h2">Signatures</h2>
            <SignaturePad label="Signature du contrôleur" value={draft.controllerSignature} onChange={(v) => update({ controllerSignature: v })} />
            <label className="flex items-center gap-3 text-base">
              <input type="checkbox" className="h-6 w-6" checked={draft.driverAbsent} onChange={(e) => update({ driverAbsent: e.target.checked })} />
              Le conducteur ne signe pas (absent…)
            </label>
            {draft.driverAbsent ? (
              <input className="input" placeholder="Pourquoi ? (ex. conducteur absent, prévenu par téléphone)" value={draft.driverAbsentReason} onChange={(e) => update({ driverAbsentReason: e.target.value.slice(0, 300) })} />
            ) : (
              <>
                <label className="block"><span className="label">Nom du conducteur</span><input className="input" value={draft.driverName} onChange={(e) => update({ driverName: e.target.value.slice(0, 100) })} /></label>
                <SignaturePad label="Signature du conducteur" value={draft.driverSignature} onChange={(v) => update({ driverSignature: v })} />
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

export function CallButton({ contact }: { contact: AlertContact }) {
  return contact.phone
    ? <a href={`tel:${contact.phone.replace(/[^+\d]/g, "")}`} className="btn-danger min-h-14 w-full text-lg">Appeler {contact.name}</a>
    : <p className="rounded-xl bg-white p-3 text-sm font-semibold text-red-800">Appelez {contact.name} immédiatement (son numéro n&apos;est pas encore enregistré dans l&apos;application).</p>;
}

function ItemCard({ item, state, onChange, contact }: { item: ChecklistItem; state: ItemState; onChange: (p: Partial<ItemState>) => void; contact: AlertContact }) {
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const a = state.answer;
  const btn = (answer: Answer, small = false) => (
    <button key={answer} type="button" aria-pressed={a === answer} onClick={() => onChange({ answer })}
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
  const repair = !!a && needsRepair(a);
  const photoNeeded = repair && item.photoRequired;
  return (
    <div className="card space-y-3">
      <p className="text-base font-semibold"><span className="mr-1 text-slate-400">{item.ref}.</span>{item.label}{item.safety && <span className="ml-2 text-xs font-normal text-red-700">sécurité</span>}</p>
      <div className="grid grid-cols-3 gap-2">{(["bon", "a_surveiller", "intervention"] as Answer[]).map((x) => btn(x))}</div>
      <div className="grid grid-cols-3 gap-2">{(["urgent", "non_verifie", "non_applicable"] as Answer[]).map((x) => btn(x, true))}</div>

      {a === "urgent" && item.safety && (
        <div className="space-y-2 rounded-xl border border-red-300 bg-red-50 p-3">
          <p className="text-sm font-semibold text-red-800">Défaillance de sécurité ({SAFETY_LABELS[item.safety]}) : le véhicule sera déclaré immobilisé à la validation. Prévenez {contact.name} tout de suite.</p>
          <CallButton contact={contact} />
        </div>
      )}
      {item.measure && a && a !== "non_applicable" && a !== "non_verifie" && (
        <input className="input" value={state.measure ?? ""} onChange={(e) => onChange({ measure: e.target.value.slice(0, 100) })} placeholder={`Mesure / valeur (${item.measure})`} aria-label="Mesure / valeur" />
      )}
      {a && (isAnomaly(a) || a === "non_verifie" || (a === "non_applicable" && item.essential)) && (
        <textarea className="input" rows={2} value={state.comment ?? ""} onChange={(e) => onChange({ comment: e.target.value })}
          placeholder={repair ? "Constat (obligatoire)" : a === "a_surveiller" ? "Constat (facultatif)" : a === "non_verifie" ? "Pourquoi ce point n'a pas été vérifié ?" : "Pourquoi N/A ?"} />
      )}
      {repair && (
        <div className="space-y-2 rounded-xl bg-slate-50 p-3">
          <span className="label">Recommandation de réparation</span>
          {a === "intervention" && (
            <div className="grid grid-cols-3 gap-2">
              {PRIORITIES.filter((p) => p !== "urgent").map((p) => <button key={p} type="button" onClick={() => onChange({ priority: p })} className={`min-h-10 rounded-lg border-2 px-1 text-sm font-semibold leading-tight ${state.priority === p ? "border-blue-700 bg-blue-700 text-white" : "border-slate-300 bg-white"}`}>{PRIORITY_LABELS[p]}</button>)}
            </div>
          )}
          <input className="input" value={state.recommendation ?? ""} onChange={(e) => onChange({ recommendation: e.target.value.slice(0, 500) })} placeholder="Réparation recommandée (facultatif)" />
          <div className="grid grid-cols-2 gap-2">
            <input className="input" inputMode="decimal" value={state.estimate ?? ""} onChange={(e) => onChange({ estimate: e.target.value.slice(0, 12) })} placeholder="Coût estimé € HT" aria-label="Coût estimé HT" />
            <input className="input" value={state.garage ?? ""} onChange={(e) => onChange({ garage: e.target.value.slice(0, 200) })} placeholder="Garage proposé" />
          </div>
        </div>
      )}
      {a && isAnomaly(a) && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">{(state.photoIds ?? []).map((id) => <Thumb key={id} id={id} onRemove={() => { deletePhoto(id).catch(() => {}); onChange({ photoIds: (state.photoIds ?? []).filter((x) => x !== id) }); }} />)}</div>
          {(state.photoIds?.length ?? 0) < 4 && (
            <label className={`btn-secondary w-full cursor-pointer ${photoNeeded && !state.photoIds?.length ? "border-red-400" : ""}`}>
              {adding ? "Préparation…" : state.photoIds?.length ? "Ajouter une autre photo" : `Photo du défaut${photoNeeded ? " (requise)" : " (facultative)"}`}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { addPhoto(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          )}
          {photoError && <p className="text-sm text-red-700">{photoError}</p>}
        </div>
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
