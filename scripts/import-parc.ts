// Reprise de l'onglet « Parc » du classeur Suivi_Parc_Auto_GSET.xlsx (affectations, site, carte grise, semaine S1–S4).
//   npm run import:parc -- chemin/vers/Suivi_Parc_Auto_GSET.xlsx            (simulation : n'écrit rien)
//   npm run import:parc -- chemin/vers/Suivi_Parc_Auto_GSET.xlsx --apply    (écrit en base)
// Ne remplace jamais une valeur déjà saisie dans l'application. Le classeur n'est pas conservé dans le dépôt
// (il contient des données nominatives). Registre, suivi des réparations et budget ne sont pas importés.
import ExcelJS from "exceljs";
import { pool } from "../src/lib/db";
import { analyzeWorkbook, type Cell, type Sheets } from "../src/lib/classeur";

function value(v: ExcelJS.CellValue): Cell {
  if (v == null || typeof v === "string" || typeof v === "number" || v instanceof Date) return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "object" && "richText" in v) return v.richText.map((t) => t.text).join("");
  if (typeof v === "object" && "text" in v) return String(v.text);
  return null; // formules : valeurs calculées ignorées (un statut calculé ne prouve rien)
}

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const apply = process.argv.includes("--apply");
  if (!file) { console.error("Usage : npm run import:parc -- <classeur.xlsx> [--apply]"); process.exit(2); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheets: Sheets = {};
  wb.eachSheet((ws) => {
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => { rows[n - 1] = Array.from({ length: ws.columnCount }, (_, c) => value(row.getCell(c + 1).value)); });
    sheets[ws.name] = Array.from(rows, (r) => r ?? []);
  });
  const { parc, skipped, warnings } = analyzeWorkbook(sheets);
  console.log(`Onglet Parc : ${parc.length} véhicule(s) lus.`);
  for (const w of warnings) console.log("⚠", w);
  const examples = skipped.filter((s) => s.example), real = skipped.filter((s) => !s.example);
  console.log(`Lignes d'exemple ignorées : ${examples.length}${examples.length ? " (" + examples.map((s) => `${s.sheet} l.${s.line}`).join(", ") + ")" : ""}`);
  for (const s of real) console.log(`⚠ ${s.sheet} ligne ${s.line} (${s.plate}) : ${s.reason}`);

  const db = pool();
  for (const v of parc) {
    const existing = (await db.query("select id, assignment, site, cg_holder, cg_status, control_week, notes from vehicles where plate = $1", [v.plate])).rows[0];
    const changes = existing
      ? Object.entries({ assignment: v.assignment, site: v.site, cg_holder: v.cgHolder, cg_status: v.cgStatus, control_week: v.week, notes: v.notes }).filter(([k, val]) => val != null && existing[k] == null).map(([k]) => k)
      : ["nouveau véhicule (statut « à confirmer »)"];
    console.log(`${v.plate} : ${changes.length ? changes.join(", ") : "rien à compléter"}${v.insuranceDue ? ` ; échéance assurance ${v.insuranceDue}` : ""}${v.ignored.length ? ` ; non repris : ${v.ignored.join(" ; ")}` : ""}`);
    if (!apply) continue;
    if (existing) {
      await db.query(`update vehicles set assignment = coalesce(assignment, $2), site = coalesce(site, $3), cg_holder = coalesce(cg_holder, $4), cg_status = coalesce(cg_status, $5),
                      control_week = coalesce(control_week, $6), notes = coalesce(notes, $7) where plate = $1`, [v.plate, v.assignment, v.site, v.cgHolder, v.cgStatus, v.week, v.notes]);
    } else {
      await db.query("insert into vehicles (plate, label, status, assignment, site, cg_holder, cg_status, control_week, notes) values ($1,$2,'a_confirmer',$3,$4,$5,$6,$7,$8)",
        [v.plate, v.label, v.assignment, v.site, v.cgHolder, v.cgStatus, v.week, v.notes]);
    }
    await db.query("insert into audit_log (action, entity, entity_id, details) select 'import_classeur', 'vehicle', id::text, $2 from vehicles where plate = $1", [v.plate, JSON.stringify({ champs: changes })]);
  }
  console.log(apply ? "Import appliqué." : "Simulation terminée : rien n'a été écrit. Ajoutez --apply pour écrire.");
  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
