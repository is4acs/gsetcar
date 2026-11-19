import { describe, expect, it } from "vitest";
import { can } from "@/lib/permissions";
import { allowedTransitions, checkTransition } from "@/lib/repair-status";
import { checklistFor, computeSummary, nacelleChecklistMissing, validateAnswers, type AnswerInput } from "@/lib/checklist";
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

describe("questionnaire", () => {
  it("tout bon : aucune anomalie constatée, jamais « apte »", () => {
    expect(validateAnswers(groups, allGood())).toEqual([]);
    expect(computeSummary(groups, allGood(), false)).toBe("aucune_anomalie");
  });
  it("un contrôle essentiel non vérifié rend le contrôle incomplet et doit être justifié", () => {
    const a = allGood();
    a.find((x) => x.itemCode === "freins_pedale")!.answer = "non_verifie";
    expect(validateAnswers(groups, a).join()).toMatch(/pourquoi/);
    expect(computeSummary(groups, a, false)).toBe("incomplet");
  });
  it("une anomalie exige commentaire et priorité ; une intervention exige délai et photo si requise", () => {
    const a = allGood();
    Object.assign(a.find((x) => x.itemCode === "pneus_av")!, { answer: "intervention" });
    const errors = validateAnswers(groups, a).join("\n");
    expect(errors).toMatch(/commentaire/); expect(errors).toMatch(/priorité/); expect(errors).toMatch(/délai/); expect(errors).toMatch(/photo/);
    expect(computeSummary(groups, a, false)).toBe("intervention");
    expect(computeSummary(groups, a, true)).toBe("critique");
  });
  it("réponse manquante refusée", () => {
    expect(validateAnswers(groups, allGood().slice(1)).length).toBe(1);
  });
  it("nacelle : points spécifiques signalés comme non définis plutôt qu'inventés", () => {
    expect(nacelleChecklistMissing({ nacelle: true })).toBe(true);
    expect(nacelleChecklistMissing({ nacelle: false })).toBe(false);
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
});
