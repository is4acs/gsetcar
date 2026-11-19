const TZ = process.env.NEXT_PUBLIC_APP_TIMEZONE || "America/Guadeloupe";

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T12:00:00Z") : new Date(d);
  return new Intl.DateTimeFormat("fr-FR", { timeZone: typeof d === "string" && d.length === 10 ? "UTC" : TZ, day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}
export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
}
/** Date locale (fuseau de l'application) au format AAAA-MM-JJ, pour les noms de fichiers. */
export function isoDay(d: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
}
export function fmtKm(n: number | null | undefined): string {
  return n == null ? "—" : new Intl.NumberFormat("fr-FR").format(n).replace(/[  ]/g, " ") + " km";
}
/** Montant en centimes → texte. NULL = « Non renseigné » (jamais confondu avec 0 €). */
export function fmtMoney(cents: number | null | undefined): string {
  if (cents == null) return "Non renseigné";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100).replace(/[  ]/g, " ");
}
/** « 1 234,50 » → 123450. Chaîne vide → null (non renseigné). Invalide → undefined. */
export function parseMoney(input: string | null | undefined): number | null | undefined {
  const s = (input ?? "").replace(/[\s  €]/g, "").replace(",", ".");
  if (s === "") return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return undefined;
  return Math.round(Number(s) * 100);
}
export function centsToInput(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2).replace(".", ",");
}
export function pgDate(d: Date | string | null): string | null {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Heure courante en millisecondes (les pages serveur sont rendues à chaque requête). */
export const nowMs = (): number => Date.now();
