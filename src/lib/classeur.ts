// Lecture du classeur Suivi_Parc_Auto_GSET.xlsx (logique pure, testée). Seul l'onglet « Parc » est repris.
// Les onglets « Registre contrôles », « Suivi réparations » et « Budget » ne sont jamais importés : leurs lignes
// préremplies sont des exemples ou des prévisions, pas des contrôles ni des dépenses réels.

export type Cell = string | number | Date | null | undefined;
export type Sheets = Record<string, Cell[][]>;

export type ParcRow = { plate: string; label: string; cgHolder: string | null; cgStatus: string | null; assignment: string | null; site: string | null; week: number | null; notes: string | null;
  insuranceDue: string | null; ignored: string[] };
export type SkippedRow = { sheet: string; line: number; plate: string; example: boolean; reason: string };

const PLATE = /^[A-Z]{2}-\d{3}-[A-Z]{2}$/;
const txt = (c: Cell): string | null => (c == null || c instanceof Date ? null : String(c).trim() || null);
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const isoDate = (c: Cell): string | null => (c instanceof Date && !Number.isNaN(c.getTime()) ? c.toISOString().slice(0, 10) : null);

/** Une ligne est un exemple si elle le dit (« EXEMPLE ») ou contient un champ factice entre crochets (« [Contrôleur] »). */
export function isExampleRow(row: Cell[]): boolean {
  return row.some((c) => typeof c === "string" && (/exemple/i.test(c) || /^\s*\[[^\]]+\]\s*$/.test(c)));
}

function table(rows: Cell[][]): { header: Map<string, number>; body: { line: number; row: Cell[] }[] } | null {
  const h = rows.findIndex((r) => r.some((c) => typeof c === "string" && norm(c) === "immatriculation"));
  if (h < 0) return null;
  const header = new Map(rows[h].map((c, i) => [typeof c === "string" ? norm(c) : `col${i}`, i]));
  return { header, body: rows.slice(h + 1).map((row, i) => ({ line: h + 2 + i, row })) };
}

export function analyzeWorkbook(sheets: Sheets): { parc: ParcRow[]; skipped: SkippedRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const parc: ParcRow[] = [];
  const skipped: SkippedRow[] = [];
  const find = (name: string) => Object.entries(sheets).find(([n]) => norm(n) === norm(name))?.[1];

  const p = find("Parc") && table(find("Parc")!);
  if (!p) warnings.push("Onglet « Parc » introuvable ou sans colonne « Immatriculation ».");
  else {
    const col = (row: Cell[], ...names: string[]) => { for (const n of names) { const i = p.header.get(norm(n)); if (i != null) return row[i]; } return null; };
    for (const { line, row } of p.body) {
      const plate = txt(col(row, "Immatriculation"))?.toUpperCase();
      if (!plate) continue;
      if (!PLATE.test(plate)) { warnings.push(`Parc ligne ${line} : immatriculation « ${plate} » ignorée (format inattendu).`); continue; }
      if (isExampleRow(row)) { skipped.push({ sheet: "Parc", line, plate, example: true, reason: "ligne d'exemple" }); continue; }
      const weekRaw = col(row, "Semaine de contrôle"), week = Number(weekRaw);
      const ignored: string[] = [];
      if (txt(col(row, "Km actuel")) != null) ignored.push("Km actuel (le kilométrage vient des contrôles)");
      if (col(row, "Date dernier CT") instanceof Date) ignored.push("Date dernier CT (le prochain CT du classeur est calculé, pas constaté : à saisir avec sa provenance)");
      parc.push({ plate, label: txt(col(row, "Véhicule")) ?? plate, cgHolder: txt(col(row, "Titulaire carte grise")), cgStatus: txt(col(row, "Statut CG")),
        assignment: txt(col(row, "Affecté à (conducteur)")), site: txt(col(row, "Site")), week: [1, 2, 3, 4].includes(week) ? week : null, notes: txt(col(row, "Observations")),
        insuranceDue: isoDate(col(row, "Échéance assurance")), ignored });
      if (weekRaw != null && ![1, 2, 3, 4].includes(week)) warnings.push(`Parc ligne ${line} : semaine de contrôle « ${String(weekRaw)} » ignorée (attendu 1 à 4).`);
    }
  }

  // Registre et suivi : jamais importés. On compte seulement, pour signaler d'éventuelles lignes réelles à reprendre.
  const exampleKeys = new Set<string>();
  for (const name of ["Registre contrôles", "Suivi réparations"]) {
    const t = find(name) && table(find(name)!);
    if (!t) continue;
    const plateCol = t.header.get("immatriculation")!;
    for (const { line, row } of t.body) {
      const plate = txt(row[plateCol])?.toUpperCase();
      if (!plate) continue;
      const dateKey = `${plate}|${row.map(isoDate).find(Boolean) ?? ""}`;
      // Une ligne du suivi qui reprend la plaque et la date d'un contrôle d'exemple est elle aussi un exemple.
      const example = isExampleRow(row) || exampleKeys.has(dateKey);
      if (example) exampleKeys.add(dateKey);
      skipped.push({ sheet: name, line, plate, example, reason: example ? "ligne d'exemple" : "ligne saisie non importée : à reprendre à la main si elle est réelle" });
    }
  }
  if (find("Budget")) warnings.push("Onglet « Budget » : montants prévisionnels préremplis non importés.");
  return { parc, skipped, warnings };
}
