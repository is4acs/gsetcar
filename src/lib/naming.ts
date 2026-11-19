import { isoDay } from "./format";

const shortId = (id: string) => id.replace(/-/g, "").slice(0, 8);
const versionSuffix = (v: number) => (v > 1 ? `_v${v}` : "");

/** Exemple : 2026-11-19_CD-736-LP_Controle_3f2a9c1e.pdf — une version corrigée ajoute _v2, sans écraser. */
export function reportFilename(plate: string, performedAt: Date | string, inspectionId: string, version: number): string {
  return `${isoDay(performedAt)}_${plate}_Controle_${shortId(inspectionId)}${versionSuffix(version)}.pdf`;
}
export function photoFilename(plate: string, performedAt: Date | string, inspectionId: string, itemCode: string, index: number): string {
  return `${isoDay(performedAt)}_${plate}_Controle_${shortId(inspectionId)}_photo_${itemCode}_${index}.jpg`;
}
export function repairDocFilename(kind: "devis" | "facture", plate: string, day: Date | string, repairId: string, n: number, originalName: string): string {
  const ext = (originalName.match(/\.(pdf|jpe?g|png)$/i)?.[1] ?? "pdf").toLowerCase().replace("jpeg", "jpg");
  return `${isoDay(day)}_${plate}_${kind === "devis" ? "Devis" : "Facture"}_${shortId(repairId)}_${n}.${ext}`;
}
