import { describe, expect, it } from "vitest";
import { can } from "@/lib/permissions";
import { allowedTransitions, checkTransition } from "@/lib/repair-status";
import { ANSWER_LABELS, SUMMARY_LABELS, checklistFor, computeSummary, nacelleChecklistMissing, planningStatus, safetyFailures, validateAnswers, weekOfMonth, type AnswerInput } from "@/lib/checklist";
import { vehiclePlanning } from "@/lib/planning";
import { analyzeWorkbook, isExampleRow } from "@/lib/classeur";
import { decrypt, encrypt } from "@/lib/secrets";
import { fmtMoney, parseMoney } from "@/lib/format";
import { reportFilename } from "@/lib/naming";
import { backoffSeconds } from "@/lib/jobs";

const groups = checklistFor({ nacelle: false });
const allGood = (): AnswerInput[] => groups.flatMap((g) => g.items.map((i) => ({ itemCode: i.code, answer: "bon" as const })));

describe("rôles", () => {
  it("le technicien ne peut pas valider une dépense ni décider d'une immobilisation", () => {
    expect(can("technicien", "repair.validate")).toBe(false);
    expect(can("technicien", "immobilization.decide")).toBe(false);
    expect(can("technicien", "dashboard.view")).toBe(false);
    expect(can("administratif", "repair.validate")).toBe(false);
    expect(can("direction", "repair.validate")).toBe(true);
  });
});

describe("statuts de réparation", () => {
  it("valider ou refuser est réservé à la direction", () => {
    expect(allowedTransitions("technicien", "a_valider")).not.toContain("valide");
    expect(allowedTransitions("technicien", "a_valider")).not.toContain("refuse");
    expect(checkTransition("technicien", "a_valider", "valide")).toMatch(/direction/);
    expect(checkTransition("direction", "a_valider", "valide")).toBeNull();
  });
  it("on ne saute pas la validation", () => {
    expect(checkTransition("direction", "devis_recu", "valide")).not.toBeNull();
    expect(checkTransition("technicien", "a_chiffrer", "en_cours")).not.toBeNull();
  });
  it("refus et annulation exigent un motif", () => {
    expect(checkTransition("direction", "a_valider", "refuse", " ")).toMatch(/motif/);
    expect(checkTransition("direction", "a_valider", "refuse", "trop cher")).toBeNull();
    expect(checkTransition("technicien", "en_cours", "annule", "")).toMatch(/motif/);
  });
});

describe("questionnaire (fiche de contrôle du classeur)", () => {
  it("reprend les 50 points en 10 rubriques, numérotés comme la fiche", () => {
    const items = groups.flatMap((g) => g.items);
    expect(groups.length).toBe(10);
    expect(items.map((i) => i.ref)).toEqual(Array.from({ length: 50 }, (_, n) => n + 1));
    expect(Object.values(ANSWER_LABELS)).toEqual(["OK", "À surveiller", "À réparer", "Urgent", "Non vérifié", "N/A"]);
  });
  it("tout OK : aucune anomalie constatée, jamais « apte »", () => {
    expect(validateAnswers(groups, allGood())).toEqual([]);
    expect(computeSummary(groups, allGood(), false)).toBe("aucune_anomalie");
    expect(Object.values(SUMMARY_LABELS).join(" ")).not.toMatch(/apte/i);
  });
  it("un contrôle essentiel non vérifié rend la fiche incomplète et doit être justifié", () => {
    const a = allGood();
    a.find((x) => x.itemCode === "p13")!.answer = "non_verifie";
    expect(validateAnswers(groups, a).join()).toMatch(/pourquoi/);
    expect(computeSummary(groups, a, false)).toBe("incomplet");
  });
  it("« À réparer » exige commentaire, délai et photo si le défaut est visible ; « À surveiller » non", () => {
    const a = allGood();
    Object.assign(a.find((x) => x.itemCode === "p07")!, { answer: "intervention" });
    Object.assign(a.find((x) => x.itemCode === "p05")!, { answer: "a_surveiller" });
    const errors = validateAnswers(groups, a);
    expect(errors.length).toBe(3);
    expect(errors.join("\n")).toMatch(/commentaire/); expect(errors.join("\n")).toMatch(/délai/); expect(errors.join("\n")).toMatch(/photo/);
    expect(computeSummary(groups, a, false)).toBe("intervention");
  });
  it("« Urgent » sur freins, pneus, direction ou éclairage : véhicule immobilisé ; ailleurs : signalement critique", () => {
    for (const [code, domain] of [["p13", "freins"], ["p08", "pneus"], ["p18", "direction"], ["p30", "eclairage"]] as const) {
      const a = allGood();
      a.find((x) => x.itemCode === code)!.answer = "urgent";
      expect(safetyFailures(groups, a).map((f) => f.domain)).toEqual([domain]);
      expect(computeSummary(groups, a, false)).toBe("immobilise");
    }
    const b = allGood();
    b.find((x) => x.itemCode === "p27")!.answer = "urgent"; // climatisation
    expect(safetyFailures(groups, b)).toEqual([]);
    expect(computeSummary(groups, b, false)).toBe("critique");
    b.find((x) => x.itemCode === "p13")!.answer = "intervention"; // « À réparer » seul n'immobilise pas
    expect(safetyFailures(groups, b)).toEqual([]);
  });
  it("réponse manquante refusée", () => {
    expect(validateAnswers(groups, allGood().slice(1)).length).toBe(1);
  });
  it("nacelle : points spécifiques signalés comme non définis plutôt qu'inventés", () => {
    expect(nacelleChecklistMissing({ nacelle: true })).toBe(true);
    expect(nacelleChecklistMissing({ nacelle: false })).toBe(false);
  });
});

describe("planning mensuel", () => {
  it("semaines S1 à S4", () => {
    expect([1, 7, 8, 14, 15, 21, 22, 31].map(weekOfMonth)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
  it("Fait / En retard / À faire comme l'onglet Planning", () => {
    const done = new Set(["2026-11"]);
    expect(planningStatus("2026-11", "2027-01", done)).toBe("fait");
    expect(planningStatus("2026-12", "2027-01", done)).toBe("en_retard");
    expect(planningStatus("2027-01", "2027-01", done)).toBe("a_faire");
    expect(planningStatus("2027-02", "2027-01", done)).toBe("a_faire");
  });
  it("véhicule : semaine prévue atteinte ou dépassée, mois en retard", () => {
    const at = (d: string) => new Date(d + "T15:00:00Z");
    expect(vehiclePlanning(3, new Set(), at("2026-11-19")).current).toMatchObject({ due: true, label: "Prévu cette semaine (S3)" });
    expect(vehiclePlanning(1, new Set(), at("2026-11-19")).current).toMatchObject({ due: true, tone: "red" });
    expect(vehiclePlanning(4, new Set(), at("2026-11-19")).current).toMatchObject({ due: false, label: "Prévu en S4" });
    expect(vehiclePlanning(1, new Set(["2026-11"]), at("2026-11-19")).current.status).toBe("fait");
    expect(vehiclePlanning(1, new Set(["2026-12"]), at("2027-01-03")).lateMonths).toEqual(["2026-11"]);
    expect(vehiclePlanning(1, new Set(), at("2026-10-10")).lateMonths).toEqual([]); // avant le début du planning
  });
});

describe("import du classeur", () => {
  const sheets = {
    Parc: [["Parc"], ["N°", "Immatriculation", "Véhicule", "Titulaire carte grise", "Statut CG", "Affecté à (conducteur)", "Site", "Km actuel", "Date dernier CT", "Prochain CT", "Échéance assurance", "Semaine de contrôle", "Observations"],
      [1, "AB-123-CD", "CITROEN TEST", "SOCIETE", "OK", "Jean TEST", "Cayenne", null, null, null, null, 2, null], [2, "pas une plaque", "X"], [3, "EF-456-GH", "RENAULT TEST", null, null, null, null, null, null, null, null, 9, null]],
    "Registre contrôles": [["Date contrôle", "Mois", "Immatriculation", "Véhicule", "Contrôleur", "Km relevé", "Remarques"],
      [new Date("2026-11-03"), null, "AB-123-CD", null, "[Contrôleur]", 125400, "EXEMPLE – à remplacer"], [new Date("2026-11-20"), null, "EF-456-GH", null, "Paul", 1000, null]],
    "Suivi réparations": [["N°", "Date constat", "Immatriculation", "Réparation"], [null, new Date("2026-11-03"), "AB-123-CD", "Plaquettes"], [null, new Date("2026-12-01"), "AB-123-CD", "Pneus"]],
    Budget: [["Poste"], ["Budget prévisionnel", 800]],
  };
  const r = analyzeWorkbook(sheets);
  it("reprend l'onglet Parc (affectation, site, semaine)", () => {
    expect(r.parc.map((v) => v.plate)).toEqual(["AB-123-CD", "EF-456-GH"]);
    expect(r.parc[0]).toMatchObject({ assignment: "Jean TEST", site: "Cayenne", week: 2, cgStatus: "OK" });
    expect(r.parc[1].week).toBeNull();
  });
  it("écarte les lignes d'exemple, y compris la réparation liée au contrôle d'exemple", () => {
    expect(r.skipped.filter((s) => s.example).map((s) => `${s.sheet}:${s.line}`)).toEqual(["Registre contrôles:2", "Suivi réparations:2"]);
    expect(isExampleRow(["x", "[Garage à définir]"])).toBe(true);
    expect(isExampleRow(["CR-761-AW", "Garage du Port"])).toBe(false);
  });
  it("n'importe jamais le registre, le suivi ni le budget : les lignes réelles sont seulement signalées", () => {
    expect(r.skipped.filter((s) => !s.example).length).toBe(2);
    expect(r.warnings.join()).toMatch(/Budget/);
  });
});

describe("montants et noms", () => {
  it("absence de coût ≠ coût nul", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("0")).toBe(0);
    expect(parseMoney("1 234,50")).toBe(123450);
    expect(parseMoney("abc")).toBeUndefined();
    expect(fmtMoney(null)).toBe("Non renseigné");
    expect(fmtMoney(0)).toBe("0,00 €");
  });
  it("nom du rapport", () => {
    expect(reportFilename("CD-736-LP", "2026-11-19T15:00:00Z", "3f2a9c1e-0000-4000-8000-000000000000", 1)).toBe("2026-11-19_CD-736-LP_Controle_3f2a9c1e.pdf");
    expect(reportFilename("CD-736-LP", "2026-11-19T15:00:00Z", "3f2a9c1e-0000-4000-8000-000000000000", 2)).toBe("2026-11-19_CD-736-LP_Controle_3f2a9c1e_v2.pdf");
  });
  it("délais de relance croissants et plafonnés", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([60, 120, 240, 480]);
    expect(backoffSeconds(30)).toBe(21600);
  });
  it("secrets chiffrés : aller-retour, et refus d'un contenu altéré", () => {
    process.env.AUTH_SECRET = "x".repeat(40);
    const c = encrypt("jeton-drive");
    expect(c).not.toContain("jeton");
    expect(decrypt(c)).toBe("jeton-drive");
    expect(() => decrypt(c.slice(0, -2) + (c.endsWith("A") ? "B" : "A") + "A")).toThrow();
  });
});
