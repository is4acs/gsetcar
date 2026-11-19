// Rapport de contrôle au format PDF (pdf-lib, sans IA ni service externe).
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { q, q1, type Db } from "./db";
import { ANSWER_LABELS, PRIORITY_LABELS, SUMMARY_LABELS, type Answer, type Priority, type Summary } from "./checklist";
import { fmtDateTime, fmtKm, fmtMoney } from "./format";

export type ReportData = {
  inspection: { id: string; performed_at: Date; mileage_km: number; previous_km: number | null; location: string | null; driver_name: string | null; driver_absent_reason: string | null; general_comment: string | null; critical_flag: boolean; critical_comment: string | null; summary: Summary; version: number; checklist_version: string };
  vehicle: { plate: string; label: string; nacelle: boolean };
  author: string;
  answers: { ref: number; group_label: string; item_label: string; essential: boolean; answer: Answer; measure: string | null; comment: string | null; priority: Priority | null; recommendation: string | null; estimate_ht_cents: number | null; garage: string | null; photos: number }[];
  signatures: { role: "controleur" | "conducteur"; signer_name: string; image: Buffer }[];
  immobilization: { status: string; auto_rule: boolean; reason: string } | null;
  corrections: { at: Date; by: string; reason: string }[];
};

export async function loadReportData(db: Db | undefined, inspectionId: string): Promise<ReportData> {
  const row = await q1<ReportData["inspection"] & { plate: string; label: string; nacelle: boolean; author: string }>(
    `select i.*, v.plate, v.label, v.nacelle, u.name as author from inspections i join vehicles v on v.id = i.vehicle_id join users u on u.id = i.author_id where i.id = $1`, [inspectionId], db);
  if (!row) throw new Error("Contrôle introuvable.");
  const answers = await q<ReportData["answers"][number]>(
    `select a.ref, a.group_label, a.item_label, a.essential, a.answer, a.measure, a.comment, a.priority, a.recommendation, a.estimate_ht_cents, a.garage,
            (select count(*)::int from documents d where d.inspection_id = a.inspection_id and d.kind = 'photo' and d.item_code = a.item_code) as photos
     from inspection_answers a where a.inspection_id = $1 order by a.position`, [inspectionId], db);
  const corrections = await q<{ at: Date; by: string; reason: string }>(
    `select l.at, coalesce(u.name, '—') as by, coalesce(l.details->>'motif', '') as reason from audit_log l left join users u on u.id = l.user_id
     where l.entity = 'inspection' and l.entity_id = $1 and l.action = 'correction' order by l.at`, [inspectionId], db);
  const immobilization = await q1<{ status: string; auto_rule: boolean; reason: string }>("select status, auto_rule, reason from immobilizations where inspection_id = $1", [inspectionId], db);
  const signatures = await q<ReportData["signatures"][number]>("select role, signer_name, image from inspection_signatures where inspection_id = $1 order by role desc", [inspectionId], db);
  return { inspection: row, vehicle: { plate: row.plate, label: row.label, nacelle: row.nacelle }, author: row.author, answers, corrections, signatures, immobilization };
}

const A4: [number, number] = [595.28, 841.89];
const M = 42;

export async function renderReport(data: ReportData): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const supported = new Set(font.getCharacterSet());
  // Les polices standard ne couvrent pas tous les caractères (émojis…) : on les remplace plutôt que d'échouer.
  const clean = (s: string) => Array.from(s.replace(/[  ]/g, " ").replace(/\r?\n/g, " ")).map((c) => (supported.has(c.codePointAt(0)!) ? c : "?")).join("");

  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - M;
  const width = A4[0] - 2 * M;
  const ensure = (h: number) => { if (y - h < M + 30) { page = pdf.addPage(A4); y = A4[1] - M; } };
  const wrap = (text: string, f: PDFFont, size: number, max: number): string[] => {
    const lines: string[] = [];
    let line = "";
    for (const word of clean(text).split(" ")) {
      let w = word;
      while (f.widthOfTextAtSize(w, size) > max) { // mot plus long que la ligne
        let cut = w.length - 1;
        while (cut > 1 && f.widthOfTextAtSize(w.slice(0, cut), size) > max) cut--;
        if (line) { lines.push(line); line = ""; }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const candidate = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(candidate, size) > max) { lines.push(line); line = w; } else line = candidate;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  };
  const text = (t: string, opts: { f?: PDFFont; size?: number; x?: number; max?: number; color?: [number, number, number]; gap?: number } = {}) => {
    const { f = font, size = 10, x = M, max = width - (x - M), color = [0.1, 0.1, 0.1], gap = 3 } = opts;
    for (const line of wrap(t, f, size, max)) {
      ensure(size + gap);
      page.drawText(line, { x, y: y - size, size, font: f, color: rgb(...color) });
      y -= size + gap;
    }
  };

  const i = data.inspection;
  text("GSET Caraïbes — Fiche de contrôle mensuel véhicule", { f: bold, size: 15 });
  y -= 4;
  text(`${data.vehicle.plate} — ${data.vehicle.label}`, { f: bold, size: 12 });
  text(`Contrôle du ${fmtDateTime(i.performed_at)} par ${data.author}`);
  text(`Kilométrage relevé : ${fmtKm(i.mileage_km)}${i.previous_km != null ? ` — dernier contrôle : ${fmtKm(i.previous_km)} — parcourus : ${fmtKm(i.mileage_km - i.previous_km)}` : ""}`);
  text(`Lieu du contrôle : ${i.location ?? "non renseigné"} — Conducteur affecté : ${i.driver_name ?? "non renseigné"}`);
  text(`Référence : ${i.id} — version ${i.version} — questionnaire ${i.checklist_version}`, { size: 8, color: [0.4, 0.4, 0.4] });
  y -= 8;

  const critical = i.summary === "immobilise" || i.summary === "critique" || i.summary === "intervention";
  text(`Synthèse : ${SUMMARY_LABELS[i.summary]}`, { f: bold, size: 12, color: critical ? [0.7, 0.1, 0.1] : [0.1, 0.1, 0.1] });
  if (i.critical_flag) text(`SIGNALEMENT : ${i.critical_comment ?? ""}`, { f: bold, color: [0.7, 0.1, 0.1] });
  if (data.immobilization?.auto_rule) text("VÉHICULE DÉCLARÉ IMMOBILISÉ à la validation de ce contrôle (défaillance de sécurité : freins, pneus, direction ou éclairage). Direction à prévenir immédiatement par téléphone.", { f: bold, color: [0.7, 0.1, 0.1] });
  else if (data.immobilization) text("Immobilisation proposée par le contrôleur (décision à prendre par la direction).", { f: bold, color: [0.7, 0.1, 0.1] });
  const count = (a: Answer) => data.answers.filter((x) => x.answer === a).length;
  text(`OK : ${count("bon")}   À surveiller : ${count("a_surveiller")}   À réparer : ${count("intervention")}   Urgent : ${count("urgent")}   Non vérifié : ${count("non_verifie")}   N/A : ${count("non_applicable")}`);
  const missing = data.answers.filter((a) => a.essential && a.answer === "non_verifie");
  if (missing.length) text(`Contrôles essentiels non vérifiés : ${missing.map((a) => a.item_label).join(" ; ")}`, { color: [0.7, 0.4, 0] });
  if (data.vehicle.nacelle && !data.answers.some((a) => a.group_label === "Nacelle")) text("Véhicule nacelle : les points spécifiques à la nacelle ne font pas partie de ce contrôle (porteur uniquement).", { color: [0.7, 0.4, 0] });
  if (i.general_comment) text(`Commentaire général : ${i.general_comment}`);
  y -= 6;

  let group = "";
  for (const a of data.answers) {
    if (a.group_label !== group) {
      group = a.group_label;
      ensure(40);
      y -= 6;
      page.drawRectangle({ x: M, y: y - 16, width, height: 16, color: rgb(0.92, 0.94, 0.97) });
      page.drawText(clean(group), { x: M + 5, y: y - 12, size: 10, font: bold });
      y -= 20;
    }
    ensure(14);
    const startY = y;
    const anomaly = a.answer === "urgent" || a.answer === "intervention" || a.answer === "a_surveiller";
    const color: [number, number, number] = a.answer === "urgent" || a.answer === "intervention" ? [0.7, 0.1, 0.1] : a.answer === "a_surveiller" ? [0.7, 0.4, 0] : a.answer === "non_verifie" ? [0.4, 0.4, 0.4] : [0.1, 0.1, 0.1];
    page.drawText(clean(ANSWER_LABELS[a.answer]), { x: M + width - 130, y: startY - 9.5, size: 9.5, font: anomaly ? bold : font, color: rgb(...color) });
    text(`${a.ref}. ${a.item_label}${a.essential ? " *" : ""}`, { size: 9.5, max: width - 140 });
    const detail = [a.measure && `Mesure : ${a.measure}`, a.comment, a.photos ? `${a.photos} photo(s) déposée(s) dans le même dossier` : null].filter(Boolean).join(" — ");
    if (detail) text(detail, { size: 8.5, x: M + 10, color: [0.3, 0.3, 0.3] });
    y -= 2;
  }

  const recos = data.answers.filter((a) => a.answer === "urgent" || a.answer === "intervention");
  if (recos.length) {
    y -= 10;
    ensure(60);
    text("Recommandations de réparation", { f: bold, size: 11 });
    for (const a of recos) {
      text(`Point ${a.ref} — ${a.recommendation ?? a.comment ?? a.item_label}`, { size: 9.5, f: bold });
      text([`Priorité : ${a.priority ? PRIORITY_LABELS[a.priority] : "—"}`, `Coût estimé : ${a.estimate_ht_cents == null ? "non chiffré" : fmtMoney(a.estimate_ht_cents) + " HT"}`, `Garage proposé : ${a.garage ?? "non renseigné"}`].join(" — "), { size: 9, x: M + 10, color: [0.3, 0.3, 0.3] });
    }
    const priced = recos.filter((a) => a.estimate_ht_cents != null);
    if (priced.length) text(`Total estimé : ${fmtMoney(priced.reduce((t, a) => t + a.estimate_ht_cents!, 0))} HT${priced.length < recos.length ? ` (sur ${priced.length}/${recos.length} recommandations chiffrées)` : ""}`, { size: 9.5, f: bold });
  }

  if (data.corrections.length) {
    y -= 8;
    text("Corrections apportées", { f: bold });
    for (const c of data.corrections) text(`${fmtDateTime(c.at)} — ${c.by} : ${c.reason}`, { size: 9 });
  }

  // Signatures : contrôleur et conducteur ; le visa de la direction est la validation des réparations dans l'application.
  y -= 12;
  ensure(110);
  const boxW = (width - 20) / 2, top = y;
  for (const [n, role, title] of [[0, "controleur", "Signature contrôleur"], [1, "conducteur", "Signature conducteur"]] as const) {
    const x = M + n * (boxW + 20);
    const sig = data.signatures.find((sg) => sg.role === role);
    page.drawText(clean(`${title}${sig ? ` — ${sig.signer_name}` : ""}`), { x, y: top - 10, size: 9, font: bold });
    page.drawRectangle({ x, y: top - 90, width: boxW, height: 74, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.5 });
    if (sig) {
      const img = await pdf.embedPng(sig.image);
      const scale = Math.min((boxW - 10) / img.width, 66 / img.height);
      page.drawImage(img, { x: x + 5, y: top - 86, width: img.width * scale, height: img.height * scale });
    } else if (role === "conducteur") {
      wrap(`Non signé : ${i.driver_absent_reason ?? "motif non renseigné"}`, font, 8.5, boxW - 12).slice(0, 5).forEach((line, k) => page.drawText(line, { x: x + 6, y: top - 30 - k * 11, size: 8.5, font, color: rgb(0.4, 0.4, 0.4) }));
    }
  }
  y = top - 98;
  text("Visa direction : la validation des réparations et des devis est enregistrée dans l'application (nom et date).", { size: 8, color: [0.4, 0.4, 0.4] });
  y -= 4;
  text("* Contrôle essentiel. Cette fiche consigne les constats du contrôleur. Elle ne remplace pas les contrôles réglementaires (contrôle technique, vérifications périodiques des nacelles) et ne constitue pas une attestation d'aptitude du véhicule.", { size: 8, color: [0.4, 0.4, 0.4] });

  const pages = pdf.getPages();
  pages.forEach((p, n) => p.drawText(clean(`${data.vehicle.plate} — contrôle ${i.id.slice(0, 8)} v${i.version} — page ${n + 1}/${pages.length}`), { x: M, y: 24, size: 8, font, color: rgb(0.5, 0.5, 0.5) }));
  pdf.setTitle(clean(`Contrôle ${data.vehicle.plate}`));
  // Dates fixes : un même contrôle (même version) produit un fichier identique à chaque génération.
  pdf.setCreationDate(new Date(i.performed_at));
  pdf.setModificationDate(new Date(i.performed_at));
  return Buffer.from(await pdf.save());
}
