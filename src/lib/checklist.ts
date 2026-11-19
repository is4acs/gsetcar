// Questionnaire de contrôle mensuel — reprise de l'onglet « Fiche de contrôle » du classeur
// Suivi_Parc_Auto_GSET.xlsx (50 points, 10 rubriques, mêmes numéros de référence).
// Chaque réponse enregistrée garde son libellé et la version du questionnaire : modifier cette liste
// n'altère pas l'historique. Changer CHECKLIST_VERSION à chaque modification.

export const CHECKLIST_VERSION = "fiche-2026-11";

// États de la fiche : OK · À surveiller · À réparer · Urgent · N/A, plus « Non vérifié » (justifié)
// pour ne jamais laisser croire qu'un point non contrôlé est bon.
export const ANSWERS = ["bon", "a_surveiller", "intervention", "urgent", "non_verifie", "non_applicable"] as const;
export type Answer = (typeof ANSWERS)[number];
export const ANSWER_LABELS: Record<Answer, string> = {
  bon: "OK",
  a_surveiller: "À surveiller",
  intervention: "À réparer",
  urgent: "Urgent",
  non_verifie: "Non vérifié",
  non_applicable: "N/A",
};

// Priorités des recommandations de réparation (liste du classeur).
export const PRIORITIES = ["urgent", "15_jours", "1_mois", "prochain_entretien"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { urgent: "Urgent", "15_jours": "Sous 15 jours", "1_mois": "Sous 1 mois", prochain_entretien: "Prochain entretien" };

export type SafetyDomain = "freins" | "pneus" | "direction" | "eclairage";
export const SAFETY_LABELS: Record<SafetyDomain, string> = { freins: "freins", pneus: "pneus", direction: "direction", eclairage: "éclairage" };

export type ChecklistItem = {
  ref: number;
  code: string;
  label: string;
  /** Organe de sécurité : « Urgent » sur ce point déclare le véhicule immobilisé (règle du classeur). */
  safety?: SafetyDomain;
  /** Contrôle essentiel : s'il n'est pas vérifié, la fiche est déclarée incomplète. */
  essential?: boolean;
  /** Indication pour le champ « Mesure / valeur ». */
  measure?: string;
  /** Photo obligatoire quand le point est « À réparer » ou « Urgent » (défaut visible). */
  photoRequired?: boolean;
};
export type ChecklistGroup = { code: string; label: string; hint?: string; nacelleOnly?: boolean; items: ChecklistItem[] };

type Opt = Omit<ChecklistItem, "ref" | "code" | "label">;
const S = (safety: SafetyDomain, more: Opt = {}): Opt => ({ safety, essential: true, ...more });
const E: Opt = { essential: true };
const i = (ref: number, label: string, opt: Opt = {}): ChecklistItem => ({ ref, code: `p${String(ref).padStart(2, "0")}`, label, ...opt });

const GROUPS: ChecklistGroup[] = [
  { code: "niveaux", label: "1. Niveaux & fluides", hint: "Moteur froid", items: [
    i(1, "Huile moteur (niveau, couleur)", E),
    i(2, "Liquide de refroidissement", E),
    i(3, "Liquide de frein", S("freins")),
    i(4, "Liquide de direction assistée", S("direction")),
    i(5, "Lave-glace"),
    i(6, "Fuites visibles sous le véhicule (huile, eau, gazole)", { essential: true, photoRequired: true }),
  ]},
  { code: "pneus", label: "2. Pneumatiques & roues", items: [
    i(7, "Pneu avant gauche (usure mm / pression)", S("pneus", { measure: "mm / bar", photoRequired: true })),
    i(8, "Pneu avant droit (usure mm / pression)", S("pneus", { measure: "mm / bar", photoRequired: true })),
    i(9, "Pneu arrière gauche (usure mm / pression)", S("pneus", { measure: "mm / bar", photoRequired: true })),
    i(10, "Pneu arrière droit (usure mm / pression)", S("pneus", { measure: "mm / bar", photoRequired: true })),
    i(11, "Roue de secours / kit anti-crevaison"),
    i(12, "Serrage des roues, jantes, flancs (hernies, coupures)", S("pneus", { photoRequired: true })),
  ]},
  { code: "freinage", label: "3. Freinage", items: [
    i(13, "Efficacité frein de service (essai)", S("freins")),
    i(14, "Frein de stationnement", S("freins")),
    i(15, "Usure plaquettes / disques (contrôle visuel)", S("freins")),
    i(16, "Bruits, vibrations au freinage", S("freins")),
    i(17, "Voyant ABS / freinage", S("freins")),
  ]},
  { code: "direction", label: "4. Direction, suspension, transmission", items: [
    i(18, "Jeu dans la direction, tenue de cap", S("direction")),
    i(19, "Amortisseurs, silentblocs"),
    i(20, "Embrayage (patinage, point de patinage)"),
    i(21, "Boîte de vitesses (passage, bruits)"),
    i(22, "Échappement (fixation, fuite, fumée)"),
  ]},
  { code: "moteur", label: "5. Moteur & électricité", items: [
    i(23, "Démarrage, ralenti, bruits moteur", E),
    i(24, "Batterie (tension V, cosses)", { measure: "V" }),
    i(25, "Courroies (accessoires / distribution : date ou km)", { measure: "date ou km" }),
    i(26, "Voyants tableau de bord (moteur, huile, airbag…)", E),
    i(27, "Climatisation"),
  ]},
  { code: "eclairage", label: "6. Éclairage & signalisation", items: [
    i(28, "Feux de croisement / route", S("eclairage")),
    i(29, "Feux de position, stop, recul", S("eclairage")),
    i(30, "Clignotants, warning", S("eclairage")),
    i(31, "Klaxon"),
    i(32, "Essuie-glaces (balais), pare-brise (impacts)", { essential: true, photoRequired: true }),
  ]},
  { code: "carrosserie", label: "7. Carrosserie & habitacle", items: [
    i(33, "Carrosserie (chocs, rayures, corrosion)", { photoRequired: true }),
    i(34, "Rétroviseurs, vitres", E),
    i(35, "Ceintures de sécurité", E),
    i(36, "Sièges, propreté intérieure"),
    i(37, "Portes, serrures, hayon"),
  ]},
  { code: "equipements", label: "8. Équipements obligatoires & sécurité", items: [
    i(38, "Gilet(s) jaune(s)"),
    i(39, "Triangle de signalisation"),
    i(40, "Extincteur (date de validité)", { measure: "date de validité" }),
    i(41, "Trousse de premiers secours"),
    i(42, "Éthylotest / constat amiable"),
  ]},
  { code: "documents", label: "9. Documents à bord", items: [
    i(43, "Carte grise (original ou copie)"),
    i(44, "Attestation d'assurance en cours"),
    i(45, "Procès-verbal du dernier contrôle technique"),
    i(46, "Carnet d'entretien / date dernière vidange", { measure: "date vidange" }),
  ]},
  { code: "metier", label: "10. Équipement métier fibre", items: [
    i(47, "Galerie / barres de toit, fixation échelle"),
    i(48, "Arrimage du matériel en soute (sangles)"),
    i(49, "Rangement, propreté soute, bobines"),
    i(50, "Outillage et EPI présents (selon inventaire)"),
  ]},
  // Points spécifiques nacelle : absents de la fiche du classeur. Structure prête, liste vide tant que
  // la fiche métier n'est pas validée : un contrôle nacelle inventé serait pire qu'une absence signalée.
  { code: "nacelle", label: "11. Nacelle", nacelleOnly: true, items: [] },
];

export function checklistFor(vehicle: { nacelle: boolean }): ChecklistGroup[] {
  return GROUPS.filter((g) => g.items.length > 0 && (!g.nacelleOnly || vehicle.nacelle));
}

/** Vrai si le véhicule est une nacelle et que ses points spécifiques ne sont pas encore définis. */
export function nacelleChecklistMissing(vehicle: { nacelle: boolean }): boolean {
  return vehicle.nacelle && GROUPS.every((g) => !g.nacelleOnly || g.items.length === 0);
}

export type AnswerInput = {
  itemCode: string; answer: Answer; measure?: string | null; comment?: string | null;
  priority?: Priority | null; recommendation?: string | null; estimateHtCents?: number | null; garage?: string | null; photoIds?: string[];
};

/** Point « À réparer » ou « Urgent » : commentaire obligatoire et reprise en recommandation de réparation. */
export const needsRepair = (a: Answer) => a === "intervention" || a === "urgent";
export const isAnomaly = (a: Answer) => a === "a_surveiller" || needsRepair(a);

/** Valide les réponses par rapport au questionnaire. Retourne la liste des erreurs (vide = valide). */
export function validateAnswers(groups: ChecklistGroup[], answers: AnswerInput[]): string[] {
  const errors: string[] = [];
  const byCode = new Map(answers.map((a) => [a.itemCode, a]));
  const known = new Set(groups.flatMap((g) => g.items.map((x) => x.code)));
  for (const a of answers) if (!known.has(a.itemCode)) errors.push(`Point inconnu : ${a.itemCode}`);
  if (byCode.size !== answers.length) errors.push("Un point est renseigné plusieurs fois.");
  for (const g of groups) for (const item of g.items) {
    const a = byCode.get(item.code);
    const name = `${item.ref}. ${item.label}`;
    if (!a) { errors.push(`${name} : réponse manquante.`); continue; }
    const hasComment = !!a.comment?.trim();
    if (needsRepair(a.answer)) {
      if (!hasComment) errors.push(`${name} : un commentaire est requis.`);
      if (a.answer === "intervention" && !a.priority) errors.push(`${name} : indiquez le délai souhaité.`);
      if (a.answer === "intervention" && a.priority === "urgent") errors.push(`${name} : pour une réparation urgente, choisissez l'état « Urgent ».`);
      if (item.photoRequired && !(a.photoIds?.length)) errors.push(`${name} : une photo du défaut est requise.`);
    }
    if (a.answer === "non_verifie" && !hasComment) errors.push(`${name} : indiquez pourquoi ce point n'a pas été vérifié.`);
    if (a.answer === "non_applicable" && item.essential && !hasComment) errors.push(`${name} : justifiez « N/A » pour ce contrôle essentiel.`);
    if ((a.photoIds?.length ?? 0) > 4) errors.push(`${name} : 4 photos au maximum.`);
  }
  return errors;
}

/** Domaines de sécurité (freins, pneus, direction, éclairage) ayant au moins un point « Urgent ». */
export function safetyFailures(groups: ChecklistGroup[], answers: Pick<AnswerInput, "itemCode" | "answer">[]): { domain: SafetyDomain; item: ChecklistItem }[] {
  const byCode = new Map(answers.map((a) => [a.itemCode, a.answer]));
  return groups.flatMap((g) => g.items).filter((x) => x.safety && byCode.get(x.code) === "urgent").map((item) => ({ domain: item.safety!, item }));
}

export const SUMMARIES = ["immobilise", "critique", "intervention", "incomplet", "a_surveiller", "aucune_anomalie"] as const;
export type Summary = (typeof SUMMARIES)[number];
// Formulations factuelles : contrairement au classeur, l'application ne propose jamais « Apte »
// (aucune conclusion automatique d'aptitude) ; elle reprend « Immobilisé » et « Fiche incomplète ».
export const SUMMARY_LABELS: Record<Summary, string> = {
  immobilise: "Immobilisé : défaillance de sécurité",
  critique: "Point urgent ou problème critique signalé",
  intervention: "Réparations à prévoir",
  incomplet: "Fiche incomplète : points essentiels non vérifiés",
  a_surveiller: "Points à surveiller",
  aucune_anomalie: "Aucune anomalie constatée sur les points vérifiés",
};

export function computeSummary(groups: ChecklistGroup[], answers: Pick<AnswerInput, "itemCode" | "answer">[], criticalFlag: boolean): Summary {
  const byCode = new Map(answers.map((a) => [a.itemCode, a.answer]));
  const items = groups.flatMap((g) => g.items);
  if (safetyFailures(groups, answers).length) return "immobilise";
  if (criticalFlag || items.some((x) => byCode.get(x.code) === "urgent")) return "critique";
  if (items.some((x) => byCode.get(x.code) === "intervention")) return "intervention";
  if (items.some((x) => x.essential && (byCode.get(x.code) ?? "non_verifie") === "non_verifie")) return "incomplet";
  if (items.some((x) => byCode.get(x.code) === "a_surveiller")) return "a_surveiller";
  return "aucune_anomalie";
}

// ---------------------------------------------------------------- Planning mensuel (S1 à S4)

/** Semaine du mois au sens du planning : S1 = du 1 au 7, S2 = 8 au 14, S3 = 15 au 21, S4 = 22 à la fin du mois. */
export const weekOfMonth = (dayOfMonth: number): 1 | 2 | 3 | 4 => Math.min(4, Math.ceil(dayOfMonth / 7)) as 1 | 2 | 3 | 4;

export type PlanningStatus = "fait" | "a_faire" | "en_retard";
export const PLANNING_LABELS: Record<PlanningStatus, string> = { fait: "Fait", a_faire: "À faire", en_retard: "En retard" };

/**
 * Statut d'un mois pour un véhicule, comme l'onglet Planning : Fait = contrôle enregistré dans le mois ;
 * En retard = mois passé sans contrôle ; À faire = mois en cours ou futur. Mois au format « AAAA-MM ».
 */
export function planningStatus(month: string, currentMonth: string, doneMonths: Set<string>): PlanningStatus {
  if (doneMonths.has(month)) return "fait";
  return month < currentMonth ? "en_retard" : "a_faire";
}
