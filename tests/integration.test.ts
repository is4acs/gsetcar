// Tests d'intégration sur une vraie base PostgreSQL (TEST_DATABASE_URL) avec le simulateur Drive.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.DRIVE_MODE = "mock";
process.env.DRIVE_MOCK_DIR = mkdtempSync(join(tmpdir(), "gset-drive-"));

const { pool, q, q1 } = await import("@/lib/db");
const { submitInspection, correctInspection } = await import("@/lib/inspections");
const { runDriveJobs, retryJobs, verifyVehicleFolder } = await import("@/lib/jobs");
const { MockDrive } = await import("@/lib/drive");
const { checklistFor } = await import("@/lib/checklist");
import type { User } from "@/lib/auth";

const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
let tech: User, tech2: User, direction: User, vehicleId: string;

const answersAllGood = () => checklistFor({ nacelle: false }).flatMap((g) => g.items.map((i) => ({ itemCode: i.code, answer: "bon" as string, comment: null as string | null, priority: null as string | null, recommendation: null as string | null, estimateHtCents: null as number | null, garage: null as string | null, photoIds: [] as string[] })));
const payload = (over: Record<string, unknown> = {}) => ({ id: randomUUID(), vehicleId, mileageKm: 120000, criticalFlag: false, controllerSignature: SIGNATURE, driverName: "Conducteur Test", driverSignature: SIGNATURE, answers: answersAllGood(), ...over });
const stagePhoto = async (user: User) => {
  const id = randomUUID();
  await q("insert into staged_uploads (id, uploader_id, mime, size_bytes, data) values ($1,$2,'image/jpeg',$3,$4)", [id, user.id, JPEG.length, JPEG]);
  return id;
};
const makeDue = () => q("update drive_jobs set next_attempt_at = now() where status in ('en_attente','bloque')");
const driveFiles = () => Object.values(new MockDrive().dump().files);

describe.skipIf(!url)("intégration", () => {
  beforeAll(async () => {
    await q("drop schema public cascade; create schema public;");
    await q(readFileSync("migrations/001_init.sql", "utf8"));
    const mk = async (email: string, role: string) => (await q1<User>("insert into users (email, name, role) values ($1,$1,$2) returning id, email, name, role", [email, role]))!;
    tech = await mk("tech@test", "technicien"); tech2 = await mk("tech2@test", "technicien"); direction = await mk("dir@test", "direction");
  });
  beforeEach(async () => {
    await q("update drive_jobs set status = 'termine' where status <> 'termine'"); // isole chaque test des envois des tests précédents
    delete process.env.DRIVE_MOCK_FAIL;
    vehicleId = (await q1<{ id: string }>("insert into vehicles (plate, label, status, drive_folder_id, drive_folder_verified_at) values ($1,'Test','actif',$2, now()) returning id",
      ["T-" + randomUUID().slice(0, 6), "folder_" + randomUUID().slice(0, 8)]))!.id;
  });
  afterAll(async () => { await pool().end(); });

  it("un contrôle crée réponses, anomalie, réparation, documents et travaux dans une seule transaction", async () => {
    const photo = await stagePhoto(tech);
    const answers = answersAllGood();
    Object.assign(answers.find((a) => a.itemCode === "p07")!, { answer: "intervention", comment: "Pneu lisse", priority: "15_jours", recommendation: "Remplacer les 2 pneus avant", estimateHtCents: 24000, garage: "Garage Test", photoIds: [photo] });
    Object.assign(answers.find((a) => a.itemCode === "p05")!, { answer: "a_surveiller" });
    const p = payload({ answers });
    const res = await submitInspection(tech, p);
    expect(res.duplicate).toBe(false);
    expect((await q1<{ summary: string }>("select summary from inspections where id = $1", [p.id]))!.summary).toBe("intervention");
    expect((await q("select 1 from issues where inspection_id = $1", [p.id])).length).toBe(2);
    // Le chiffrage proposé par le contrôleur est repris dans la réparation : aucune ressaisie.
    const repairs = await q("select status, title, garage, estimate_ht_cents, estimate_ttc_cents from repairs where vehicle_id = $1", [vehicleId]);
    expect(repairs).toEqual([{ status: "a_chiffrer", title: "Remplacer les 2 pneus avant", garage: "Garage Test", estimate_ht_cents: 24000, estimate_ttc_cents: null }]);
    expect((await q("select role from inspection_signatures where inspection_id = $1 order by role", [p.id])).map((r) => r.role)).toEqual(["conducteur", "controleur"]);
    expect((await q("select 1 from immobilizations where vehicle_id = $1", [vehicleId])).length).toBe(0);
    expect((await q("select 1 from drive_jobs j join documents d on d.id = j.document_id where d.inspection_id = $1", [p.id])).length).toBe(2);
    expect((await q("select 1 from staged_uploads where id = $1", [photo])).length).toBe(0);
  });

  it("double clic / relance : aucune donnée ni fichier en double", async () => {
    const p = payload();
    const results = await Promise.all([submitInspection(tech, p), submitInspection(tech, p), submitInspection(tech, p)]);
    expect(results.filter((r) => !r.duplicate).length).toBe(1);
    expect((await q("select 1 from inspections where id = $1", [p.id])).length).toBe(1);
    expect((await q("select 1 from documents where inspection_id = $1", [p.id])).length).toBe(1);
    await Promise.all([runDriveJobs(), runDriveJobs()]);
    await runDriveJobs();
    const doc = (await q1<{ sync_status: string; filename: string }>("select sync_status, filename from documents where inspection_id = $1", [p.id]))!;
    expect(doc.sync_status).toBe("depose");
    expect(driveFiles().filter((f) => f.name === doc.filename).length).toBe(1);
  });

  it("un autre utilisateur ne peut pas réutiliser l'identifiant d'un contrôle", async () => {
    const p = payload();
    await submitInspection(tech, p);
    await expect(submitInspection(tech2, p)).rejects.toMatchObject({ status: 409 });
  });

  it("panne Drive : le contrôle reste enregistré, l'envoi attend puis reprend", async () => {
    const p = payload();
    process.env.DRIVE_MOCK_FAIL = "down";
    await submitInspection(tech, p);
    const r1 = await runDriveJobs();
    expect(r1.retry).toBe(1);
    const job = (await q1<{ status: string; attempts: number; last_error: string; wait: number }>(
      "select j.status, j.attempts, j.last_error, extract(epoch from j.next_attempt_at - now())::int as wait from drive_jobs j join documents d on d.id = j.document_id where d.inspection_id = $1", [p.id]))!;
    expect(job).toMatchObject({ status: "en_attente", attempts: 1 });
    expect(job.wait).toBeGreaterThan(30);
    expect(job.last_error).toMatch(/indisponible/);
    expect((await runDriveJobs()).claimed).toBe(0); // pas encore l'heure
    delete process.env.DRIVE_MOCK_FAIL;
    expect(await retryJobs(direction.id)).toBeGreaterThan(0); // reprise manuelle
    expect((await runDriveJobs()).done).toBe(1);
    expect((await q("select 1 from document_blobs b join documents d on d.id = b.document_id where d.inspection_id = $1", [p.id])).length).toBe(0);
  });

  it("Drive a accepté le fichier mais la réponse est perdue : pas de second fichier à la reprise", async () => {
    const photo = await stagePhoto(tech);
    const answers = answersAllGood();
    Object.assign(answers.find((a) => a.itemCode === "p33")!, { answer: "a_surveiller", comment: "Rayure", photoIds: [photo] });
    const p = payload({ answers });
    await submitInspection(tech, p);
    process.env.DRIVE_MOCK_FAIL = "create_lost";
    expect((await runDriveJobs()).retry).toBe(2);
    // Le fichier temporaire n'est pas supprimé tant que le dépôt n'est pas confirmé.
    expect((await q("select 1 from document_blobs where document_id = $1", [photo])).length).toBe(1);
    delete process.env.DRIVE_MOCK_FAIL;
    await makeDue();
    expect((await runDriveJobs()).done).toBe(2);
    const docs = await q<{ filename: string; drive_file_id: string; sync_status: string }>("select filename, drive_file_id, sync_status from documents where inspection_id = $1", [p.id]);
    for (const d of docs) {
      expect(d.sync_status).toBe("depose");
      expect(driveFiles().filter((f) => f.name === d.filename).length).toBe(1);
    }
    expect((await q("select 1 from document_blobs where document_id = $1", [photo])).length).toBe(0);
  });

  it("dossier non vérifié : envoi bloqué et visible, débloqué après vérification, sous-dossier Contrôles unique", async () => {
    await q("update vehicles set drive_folder_verified_at = null where id = $1", [vehicleId]);
    const p1 = payload(), p2 = payload({ mileageKm: 120500 });
    await submitInspection(tech, p1);
    expect(await runDriveJobs()).toMatchObject({ blocked: 1, done: 0 });
    const job = (await q1<{ status: string; attempts: number; last_error: string }>("select status, attempts, last_error from drive_jobs j join documents d on d.id = j.document_id where d.inspection_id = $1", [p1.id]))!;
    expect(job).toMatchObject({ status: "bloque", attempts: 0 });
    expect(job.last_error).toMatch(/vérifié/);
    expect((await verifyVehicleFolder(direction.id, vehicleId)).ok).toBe(true);
    await submitInspection(tech, p2);
    await Promise.all([runDriveJobs(), runDriveJobs(), runDriveJobs()]);
    const v = (await q1<{ drive_folder_id: string; drive_controles_folder_id: string }>("select drive_folder_id, drive_controles_folder_id from vehicles where id = $1", [vehicleId]))!;
    const folders = Object.values(new MockDrive().dump().folders).filter((f) => f.parentId === v.drive_folder_id);
    expect(folders).toEqual([{ name: "Contrôles", parentId: v.drive_folder_id }]);
    expect(driveFiles().filter((f) => f.parentId === v.drive_controles_folder_id).length).toBe(2);
  });

  it("véhicule sans dossier Drive (DV-454-FA) : contrôle saisi, rapport en attente jusqu'à l'association du dossier", async () => {
    await q("update vehicles set drive_folder_id = null, drive_folder_verified_at = null where id = $1", [vehicleId]);
    const p = payload();
    await submitInspection(tech, p);
    expect(await runDriveJobs()).toMatchObject({ blocked: 1, done: 0 });
    expect((await q1<{ last_error: string }>("select last_error from drive_jobs j join documents d on d.id = j.document_id where d.inspection_id = $1", [p.id]))!.last_error).toMatch(/Aucun dossier Drive/);
    expect((await q("select 1 from document_blobs b join documents d on d.id = b.document_id where d.inspection_id = $1", [p.id])).length).toBe(0); // rapport pas encore généré, rien de perdu
    await q("update vehicles set drive_folder_id = $2 where id = $1", [vehicleId, "folder_late_" + randomUUID().slice(0, 6)]);
    const v = await verifyVehicleFolder(direction.id, vehicleId); // dépôt pilote
    expect(v).toMatchObject({ ok: true });
    expect(v.message).toMatch(/dépôt pilote réussi/);
    expect(driveFiles().some((f) => f.name.startsWith("_GSET_test_depot"))).toBe(false); // fichier témoin retiré
    expect((await runDriveJobs()).done).toBe(1);
    expect((await q1<{ sync_status: string }>("select sync_status from documents where inspection_id = $1", [p.id]))!.sync_status).toBe("depose");
  });

  it("défaillance de sécurité (freins) : véhicule déclaré immobilisé automatiquement, sans doublon à la relance", async () => {
    const answers = answersAllGood();
    Object.assign(answers.find((a) => a.itemCode === "p13")!, { answer: "urgent", comment: "Pédale molle, freinage insuffisant" });
    const p = payload({ answers, driverSignature: null, driverAbsentReason: "Conducteur absent" });
    await submitInspection(tech, p);
    await submitInspection(tech, p);
    const immos = await q<{ status: string; auto_rule: boolean; decided_by: string | null; reason: string }>("select status, auto_rule, decided_by, reason from immobilizations where vehicle_id = $1", [vehicleId]);
    expect(immos.length).toBe(1);
    expect(immos[0]).toMatchObject({ status: "active", auto_rule: true, decided_by: null });
    expect(immos[0].reason).toMatch(/freins/);
    const i = (await q1<{ summary: string; critical_flag: boolean; driver_absent_reason: string }>("select summary, critical_flag, driver_absent_reason from inspections where id = $1", [p.id]))!;
    expect(i).toEqual({ summary: "immobilise", critical_flag: true, driver_absent_reason: "Conducteur absent" });
    expect((await q1<{ urgent: boolean }>("select urgent from repairs where vehicle_id = $1", [vehicleId]))!.urgent).toBe(true);
    // Un « Urgent » hors organes de sécurité signale sans immobiliser.
    await q("update immobilizations set status = 'levee' where vehicle_id = $1", [vehicleId]);
    const others = answersAllGood();
    Object.assign(others.find((a) => a.itemCode === "p27")!, { answer: "urgent", comment: "Climatisation HS" });
    await submitInspection(tech, payload({ answers: others }));
    expect((await q("select 1 from immobilizations where vehicle_id = $1 and status = 'active'", [vehicleId])).length).toBe(0);
  });

  it("signatures : contrôleur obligatoire, conducteur signé ou absence justifiée", async () => {
    await expect(submitInspection(tech, payload({ controllerSignature: undefined }))).rejects.toMatchObject({ status: 422 });
    await expect(submitInspection(tech, payload({ driverSignature: null }))).rejects.toMatchObject({ status: 422 });
    await expect(submitInspection(tech, payload({ controllerSignature: "data:image/png;base64,AAAA" }))).rejects.toMatchObject({ status: 422 });
  });

  it("dossier inaccessible en écriture : la vérification échoue", async () => {
    await q("update vehicles set drive_folder_id = 'lecture_seule', drive_folder_verified_at = null where id = $1", [vehicleId]);
    const r = await verifyVehicleFolder(direction.id, vehicleId);
    expect(r.ok).toBe(false);
    expect((await q1<{ t: Date | null }>("select drive_folder_verified_at as t from vehicles where id = $1", [vehicleId]))!.t).toBeNull();
  });

  it("correction : tracée, versionnée, l'ancien rapport est conservé avec ses valeurs d'origine", async () => {
    const p = payload({ mileageKm: 130000 });
    await submitInspection(tech, p);
    await expect(correctInspection(tech2, p.id, { mileageKm: 1, reason: "test" })).rejects.toMatchObject({ status: 403 });
    await expect(correctInspection(tech, p.id, { mileageKm: 131000, reason: "" })).rejects.toMatchObject({ status: 422 });
    expect(await correctInspection(tech, p.id, { mileageKm: 131000, reason: "Erreur de lecture du compteur" })).toEqual({ version: 2, changed: true });
    expect((await correctInspection(tech, p.id, { mileageKm: 131000, reason: "double clic" })).changed).toBe(false);
    await runDriveJobs();
    const docs = await q<{ version: number; filename: string; drive_file_id: string; sync_status: string }>("select version, filename, drive_file_id, sync_status from documents where inspection_id = $1 order by version", [p.id]);
    expect(docs.map((d) => d.version)).toEqual([1, 2]);
    expect(docs[1].filename).toMatch(/_v2\.pdf$/);
    expect(docs.every((d) => d.sync_status === "depose")).toBe(true);
    const size = (id: string) => readFileSync(join(process.env.DRIVE_MOCK_DIR!, id)).length;
    expect(size(docs[0].drive_file_id)).toBeLessThan(size(docs[1].drive_file_id)); // la v2 mentionne la correction
    const log = (await q1<{ details: { avant: { km: number }; apres: { km: number }; motif: string } }>("select details from audit_log where entity = 'inspection' and entity_id = $1 and action = 'correction'", [p.id]))!;
    expect(log.details).toMatchObject({ avant: { km: 130000 }, apres: { km: 131000 }, motif: "Erreur de lecture du compteur" });
    expect(readdirSync(process.env.DRIVE_MOCK_DIR!).length).toBeGreaterThan(2);
  });

  it("garde-fous : véhicule hors parc actif, kilométrage en baisse, photo manquante, périmètre, rôle", async () => {
    await submitInspection(tech, payload({ mileageKm: 50000 }));
    await expect(submitInspection(tech, payload({ mileageKm: 40000 }))).rejects.toMatchObject({ status: 422, details: { code: "kilometrage_inferieur" } });
    await submitInspection(tech, payload({ mileageKm: 40000, mileageLowerConfirmed: true }));
    const answers = answersAllGood();
    Object.assign(answers[5], { answer: "intervention", comment: "x", priority: "1_mois", photoIds: [await stagePhoto(tech2)] }); // photo d'un autre utilisateur
    await expect(submitInspection(tech, payload({ answers }))).rejects.toMatchObject({ details: { code: "photos_manquantes" } });
    await expect(submitInspection({ ...tech, role: "administratif" }, payload())).rejects.toMatchObject({ status: 403 });
    const other = (await q1<{ id: string }>("insert into vehicles (plate, label, status) values ($1,'Autre','actif') returning id", ["O-" + randomUUID().slice(0, 6)]))!.id;
    await q("insert into user_vehicle_scope (user_id, vehicle_id) values ($1,$2)", [tech2.id, other]);
    await expect(submitInspection(tech2, payload())).rejects.toMatchObject({ status: 404 }); // hors périmètre
    await q("update vehicles set status = 'vendu' where id = $1", [vehicleId]);
    await expect(submitInspection(tech, payload())).rejects.toMatchObject({ status: 422 });
  });
});
