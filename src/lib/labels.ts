import type { Tone } from "@/components/ui";
import type { RepairStatus } from "./repair-status";
import type { Summary, Priority } from "./checklist";

export const REPAIR_TONES: Record<RepairStatus, Tone> = {
  a_chiffrer: "amber", devis_recu: "amber", a_valider: "red", valide: "blue", planifie: "blue", en_cours: "blue", termine: "green", refuse: "gray", annule: "gray",
};
export const SUMMARY_TONES: Record<Summary, Tone> = { immobilise: "red", critique: "red", intervention: "red", incomplet: "amber", a_surveiller: "amber", aucune_anomalie: "green" };
export const PRIORITY_TONES: Record<Priority, Tone> = { urgent: "red", "15_jours": "amber", "1_mois": "blue", prochain_entretien: "gray" };

export const JOB_LABELS: Record<string, string> = { en_attente: "En attente d'envoi", en_cours: "Envoi en cours", termine: "Déposé sur Drive", echec: "Échec — reprise manuelle requise", bloque: "Bloqué — action requise" };
export const JOB_TONES: Record<string, Tone> = { en_attente: "amber", en_cours: "blue", termine: "green", echec: "red", bloque: "red" };
export const DOC_KIND_LABELS: Record<string, string> = { rapport_controle: "Rapport de contrôle", photo: "Photo", devis: "Devis", facture: "Facture" };
export const VEHICLE_STATUS_LABELS: Record<string, string> = { actif: "Actif", a_confirmer: "Statut à confirmer", vendu: "Vendu" };
export const DEADLINE_LABELS: Record<string, string> = { ct: "Contrôle technique", assurance: "Assurance", entretien: "Entretien", autre: "Autre" };
export const IMMO_LABELS: Record<string, string> = { proposee: "Proposée", active: "Immobilisé", rejetee: "Proposition rejetée", levee: "Remis en service" };
