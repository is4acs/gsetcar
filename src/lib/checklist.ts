// Questionnaire de contrôle, version 1.
// ⚠ Version provisoire construite à partir des groupes du cadrage. À rapprocher de l'onglet
// « Fiche de contrôle » du classeur Suivi_Parc_Auto_GSET.xlsx avant mise en service.
// Chaque réponse enregistrée garde son libellé et la version du questionnaire : modifier
// cette liste n'altère pas l'historique. Changer CHECKLIST_VERSION à chaque modification.

export const CHECKLIST_VERSION = "v1-provisoire";

export const ANSWERS = ["bon", "a_surveiller", "intervention", "non_verifie", "non_applicable"] as const;
export type Answer = (typeof ANSWERS)[number];
export const ANSWER_LABELS: Record<Answer, string> = {
  bon: "Bon",
  a_surveiller: "À surveiller",
  intervention: "Intervention nécessaire",
  non_verifie: "Non vérifié",
  non_applicable: "Non applicable",
};

export const PRIORITIES = ["basse", "normale", "haute", "urgente"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { basse: "Basse", normale: "Normale", haute: "Haute", urgente: "Urgente" };

export const DELAYS = ["immediat", "7_jours", "30_jours", "prochain_entretien"] as const;
export type Delay = (typeof DELAYS)[number];
export const DELAY_LABELS: Record<Delay, string> = { immediat: "Immédiat", "7_jours": "Sous 7 jours", "30_jours": "Sous 30 jours", prochain_entretien: "Au prochain entretien" };

export type ChecklistItem = {
  code: string;
  label: string;
  /** Contrôle essentiel : s'il n'est pas vérifié, le contrôle est déclaré incomplet. */
  essential?: boolean;
  /** Photo obligatoire quand la réponse est « Intervention nécessaire ». */
  photoRequired?: boolean;
};
export type ChecklistGroup = { code: string; label: string; nacelleOnly?: boolean; items: ChecklistItem[] };

const GROUPS: ChecklistGroup[] = [
  { code: "pneus", label: "Pneus", items: [
    { code: "pneus_av", label: "État et usure des pneus avant", essential: true, photoRequired: true },
    { code: "pneus_ar", label: "État et usure des pneus arrière", essential: true, photoRequired: true },
    { code: "pneus_pression", label: "Pression des pneus", essential: true },
    { code: "pneus_secours", label: "Roue de secours ou kit anti-crevaison" },
  ]},
  { code: "freins", label: "Freins", items: [
    { code: "freins_pedale", label: "Freinage : course et efficacité de la pédale", essential: true },
    { code: "freins_main", label: "Frein de stationnement", essential: true },
    { code: "freins_liquide", label: "Niveau du liquide de frein", essential: true },
    { code: "freins_visuel", label: "Plaquettes et disques (contrôle visuel)" },
  ]},
  { code: "niveaux", label: "Niveaux et fuites", items: [
    { code: "niv_huile", label: "Niveau d'huile moteur", essential: true },
    { code: "niv_refroidissement", label: "Niveau du liquide de refroidissement", essential: true },
    { code: "niv_lave_glace", label: "Niveau du lave-glace" },
    { code: "niv_adblue", label: "Niveau d'AdBlue (si équipé)" },
    { code: "niv_fuites", label: "Fuites visibles sous le véhicule", essential: true, photoRequired: true },
  ]},
  { code: "eclairage", label: "Éclairage", items: [
    { code: "ecl_feux", label: "Feux de position, de croisement et de route", essential: true },
    { code: "ecl_stop", label: "Feux stop", essential: true },
    { code: "ecl_clignotants", label: "Clignotants et feux de détresse", essential: true },
    { code: "ecl_recul_plaque", label: "Feu de recul et éclairage de plaque" },
    { code: "ecl_gyrophare", label: "Gyrophare ou signalisation de chantier (si équipé)" },
  ]},
  { code: "batterie", label: "Batterie", items: [
    { code: "bat_demarrage", label: "Démarrage du moteur", essential: true },
    { code: "bat_cosses", label: "Fixation de la batterie et état des cosses" },
    { code: "bat_voyants", label: "Voyants d'alerte au tableau de bord", essential: true },
  ]},
  { code: "carrosserie", label: "Carrosserie et équipements", items: [
    { code: "car_carrosserie", label: "Carrosserie : chocs, éléments mal fixés", photoRequired: true },
    { code: "car_pare_brise", label: "Pare-brise et essuie-glaces", essential: true, photoRequired: true },
    { code: "car_retroviseurs", label: "Rétroviseurs", essential: true },
    { code: "car_ceintures", label: "Ceintures de sécurité", essential: true },
    { code: "car_klaxon", label: "Avertisseur sonore" },
    { code: "car_securite", label: "Équipements de sécurité (gilet, triangle, extincteur, trousse)" },
    { code: "car_chargement", label: "Arrimage du chargement et galerie" },
    { code: "car_documents", label: "Documents de bord présents" },
  ]},
  // Points spécifiques nacelle : structure prête, liste volontairement vide tant que la fiche
  // métier n'est pas validée. Un contrôle nacelle inventé serait pire qu'une absence signalée.
  { code: "nacelle", label: "Nacelle", nacelleOnly: true, items: [] },
];

export function checklistFor(vehicle: { nacelle: boolean }): ChecklistGroup[] {
  return GROUPS.filter((g) => g.items.length > 0 && (!g.nacelleOnly || vehicle.nacelle));
}

/** Vrai si le véhicule est une nacelle et que ses points spécifiques ne sont pas encore définis. */
export function nacelleChecklistMissing(vehicle: { nacelle: boolean }): boolean {
  return vehicle.nacelle && GROUPS.every((g) => !g.nacelleOnly || g.items.length === 0);
}

export type AnswerInput = { itemCode: string; answer: Answer; comment?: string | null; priority?: Priority | null; delay?: Delay | null; photoIds?: string[] };

export const isAnomaly = (a: Answer) => a === "a_surveiller" || a === "intervention";

/** Valide les réponses par rapport au questionnaire. Retourne la liste des erreurs (vide = valide). */
export function validateAnswers(groups: ChecklistGroup[], answers: AnswerInput[]): string[] {
  const errors: string[] = [];
  const byCode = new Map(answers.map((a) => [a.itemCode, a]));
  const known = new Set(groups.flatMap((g) => g.items.map((i) => i.code)));
  for (const a of answers) if (!known.has(a.itemCode)) errors.push(`Point inconnu : ${a.itemCode}`);
  if (byCode.size !== answers.length) errors.push("Un point est renseigné plusieurs fois.");
  for (const g of groups) for (const item of g.items) {
    const a = byCode.get(item.code);
    if (!a) { errors.push(`${item.label} : réponse manquante.`); continue; }
    const hasComment = !!a.comment?.trim();
    if (isAnomaly(a.answer)) {
      if (!hasComment) errors.push(`${item.label} : un commentaire est requis pour une anomalie.`);
      if (!a.priority) errors.push(`${item.label} : la priorité est requise.`);
      if (a.answer === "intervention" && !a.delay) errors.push(`${item.label} : le délai proposé est requis.`);
      if (a.answer === "intervention" && item.photoRequired && !(a.photoIds?.length)) errors.push(`${item.label} : une photo est requise.`);
    }
    if (a.answer === "non_verifie" && !hasComment) errors.push(`${item.label} : indiquez pourquoi ce point n'a pas été vérifié.`);
    if (a.answer === "non_applicable" && item.essential && !hasComment) errors.push(`${item.label} : justifiez « Non applicable » pour ce contrôle essentiel.`);
    if ((a.photoIds?.length ?? 0) > 4) errors.push(`${item.label} : 4 photos au maximum.`);
  }
  return errors;
}

export const SUMMARIES = ["critique", "intervention", "incomplet", "a_surveiller", "aucune_anomalie"] as const;
export type Summary = (typeof SUMMARIES)[number];
// Formulations volontairement factuelles : l'application ne déclare jamais un véhicule « apte ».
export const SUMMARY_LABELS: Record<Summary, string> = {
  critique: "Problème critique signalé",
  intervention: "Intervention nécessaire",
  incomplet: "Contrôle incomplet : points essentiels non vérifiés",
  a_surveiller: "Points à surveiller",
  aucune_anomalie: "Aucune anomalie constatée sur les points vérifiés",
};

export function computeSummary(groups: ChecklistGroup[], answers: Pick<AnswerInput, "itemCode" | "answer">[], criticalFlag: boolean): Summary {
  const byCode = new Map(answers.map((a) => [a.itemCode, a.answer]));
  const items = groups.flatMap((g) => g.items);
  if (criticalFlag) return "critique";
  if (items.some((i) => byCode.get(i.code) === "intervention")) return "intervention";
  if (items.some((i) => i.essential && (byCode.get(i.code) ?? "non_verifie") === "non_verifie")) return "incomplet";
  if (items.some((i) => byCode.get(i.code) === "a_surveiller")) return "a_surveiller";
  return "aucune_anomalie";
}
