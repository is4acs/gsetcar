import { can, type Role } from "./permissions";

export const REPAIR_STATUSES = ["a_chiffrer", "devis_recu", "a_valider", "valide", "planifie", "en_cours", "termine", "refuse", "annule"] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];

export const REPAIR_STATUS_LABELS: Record<RepairStatus, string> = {
  a_chiffrer: "À chiffrer",
  devis_recu: "Devis reçu",
  a_valider: "À valider",
  valide: "Validé",
  planifie: "Planifié",
  en_cours: "En cours",
  termine: "Terminé",
  refuse: "Refusé",
  annule: "Annulé",
};

export const OPEN_REPAIR_STATUSES: RepairStatus[] = ["a_chiffrer", "devis_recu", "a_valider", "valide", "planifie", "en_cours"];
/** À partir de ces statuts, la dépense a été validée : le montant estimé est verrouillé. */
export const VALIDATED_STATUSES: RepairStatus[] = ["valide", "planifie", "en_cours", "termine"];

const NEXT: Record<RepairStatus, RepairStatus[]> = {
  a_chiffrer: ["devis_recu", "annule"],
  devis_recu: ["a_valider", "a_chiffrer", "annule"],
  a_valider: ["valide", "refuse", "devis_recu", "annule"],
  valide: ["planifie", "en_cours", "annule"],
  planifie: ["en_cours", "valide", "annule"],
  en_cours: ["termine", "planifie", "annule"],
  termine: [],
  refuse: ["a_chiffrer"], // nouveau chiffrage après refus
  annule: [],
};

export function requiresReason(to: RepairStatus): boolean {
  return to === "refuse" || to === "annule";
}

/** Transitions réservées à la direction : valider ou refuser une dépense. */
function isBudgetDecision(from: RepairStatus, to: RepairStatus): boolean {
  return from === "a_valider" && (to === "valide" || to === "refuse");
}

export function allowedTransitions(role: Role, from: RepairStatus): RepairStatus[] {
  if (!can(role, "repair.edit")) return [];
  return NEXT[from].filter((to) => !isBudgetDecision(from, to) || can(role, "repair.validate"));
}

export function checkTransition(role: Role, from: RepairStatus, to: RepairStatus, reason?: string | null): string | null {
  if (!NEXT[from]?.includes(to)) return `Passage de « ${REPAIR_STATUS_LABELS[from]} » à « ${REPAIR_STATUS_LABELS[to] ?? to} » impossible.`;
  if (!allowedTransitions(role, from).includes(to)) return "La validation ou le refus d'une dépense est réservé à la direction.";
  if (requiresReason(to) && !reason?.trim()) return "Un motif est obligatoire.";
  return null;
}
