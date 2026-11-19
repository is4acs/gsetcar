import { z } from "zod";
import { ApiError, canAccessVehicle, type User } from "./auth";
import { audit, q, q1, tx } from "./db";
import { ANSWERS, CHECKLIST_VERSION, DELAYS, PRIORITIES, checklistFor, computeSummary, isAnomaly, validateAnswers } from "./checklist";
import { can } from "./permissions";
import { photoFilename, reportFilename } from "./naming";
import { materializeBlob } from "./jobs";

const text = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

export const inspectionPayload = z.object({
  id: z.uuid(),
  vehicleId: z.uuid(),
  mileageKm: z.number().int().min(0).max(2_000_000),
  /** Le technicien confirme un kilométrage inférieur au dernier relevé (erreur précédente, compteur changé…). */
  mileageLowerConfirmed: z.boolean().optional(),
  generalComment: text(2000),
  criticalFlag: z.boolean(),
  criticalComment: text(1000),
  proposeImmobilization: z.boolean().optional(),
  answers: z.array(z.object({
    itemCode: z.string().max(60),
    answer: z.enum(ANSWERS),
    comment: text(1000),
    priority: z.enum(PRIORITIES).nullish(),
    delay: z.enum(DELAYS).nullish(),
    photoIds: z.array(z.uuid()).max(4).optional(),
  })).max(200),
});
export type InspectionPayload = z.infer<typeof inspectionPayload>;

/**
 * Enregistre un contrôle validé. Une seule transaction crée le contrôle, ses réponses, les anomalies,
 * les réparations à chiffrer, les documents et leurs travaux d'envoi Drive.
 * Rejouable sans effet : l'identifiant vient du téléphone, une seconde soumission retourne le contrôle existant.
 */
export async function submitInspection(user: User, input: unknown): Promise<{ id: string; duplicate: boolean }> {
  if (!can(user.role, "inspection.create")) throw new ApiError(403, "Action non autorisée pour votre rôle.");
  const parsed = inspectionPayload.safeParse(input);
  if (!parsed.success) throw new ApiError(422, "Données du contrôle invalides.", parsed.error.issues.map((i) => i.message));
  const p = parsed.data;
  if (!(await canAccessVehicle(user, p.vehicleId))) throw new ApiError(404, "Véhicule introuvable.");

  return tx(async (db) => {
    // Sérialise les soumissions concurrentes du même véhicule (double clic, deux onglets).
    const vehicle = await q1<{ id: string; plate: string; nacelle: boolean; status: string }>("select id, plate, nacelle, status from vehicles where id = $1 for update", [p.vehicleId], db);
    if (!vehicle) throw new ApiError(404, "Véhicule introuvable.");
    const existing = await q1<{ author_id: string; vehicle_id: string }>("select author_id, vehicle_id from inspections where id = $1", [p.id], db);
    if (existing) {
      if (existing.author_id !== user.id || existing.vehicle_id !== p.vehicleId) throw new ApiError(409, "Identifiant de contrôle déjà utilisé.");
      return { id: p.id, duplicate: true };
    }
    if (vehicle.status !== "actif") throw new ApiError(422, "Ce véhicule n'est pas dans le parc actif.");

    const groups = checklistFor(vehicle);
    const errors = validateAnswers(groups, p.answers.map((a) => ({ ...a, comment: a.comment })));
    if (p.criticalFlag && !p.criticalComment) errors.push("Décrivez le problème critique signalé.");
    if (p.proposeImmobilization && !p.criticalFlag) errors.push("Une proposition d'immobilisation doit accompagner un problème critique.");
    if (errors.length) throw new ApiError(422, "Le contrôle est incomplet.", errors);

    const last = await q1<{ km: number | null }>("select max(mileage_km) as km from inspections where vehicle_id = $1", [vehicle.id], db);
    if (last?.km != null && p.mileageKm < last.km && !p.mileageLowerConfirmed)
      throw new ApiError(422, `Le kilométrage saisi est inférieur au dernier relevé (${last.km} km). Confirmez-le ou corrigez-le.`, { code: "kilometrage_inferieur", dernier: last.km });

    const photoIds = p.answers.flatMap((a) => a.photoIds ?? []);
    if (new Set(photoIds).size !== photoIds.length) throw new ApiError(422, "Une photo est rattachée à plusieurs points.");
    const staged = await q<{ id: string }>("select id from staged_uploads where id = any($1::uuid[]) and uploader_id = $2 for update", [photoIds, user.id], db);
    if (staged.length !== photoIds.length) {
      const have = new Set(staged.map((s) => s.id));
      throw new ApiError(422, "Certaines photos n'ont pas été reçues. Renvoyez-les.", { code: "photos_manquantes", manquantes: photoIds.filter((id) => !have.has(id)) });
    }

    const summary = computeSummary(groups, p.answers, p.criticalFlag);
    const now = new Date();
    await q(`insert into inspections (id, vehicle_id, author_id, performed_at, mileage_km, checklist_version, general_comment, critical_flag, critical_comment, summary)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.id, vehicle.id, user.id, now, p.mileageKm, CHECKLIST_VERSION, p.generalComment, p.criticalFlag, p.criticalFlag ? p.criticalComment : null, summary], db);

    const byCode = new Map(p.answers.map((a) => [a.itemCode, a]));
    let position = 0;
    for (const g of groups) for (const item of g.items) {
      const a = byCode.get(item.code)!;
      const anomaly = isAnomaly(a.answer);
      const answer = await q1<{ id: string }>(
        `insert into inspection_answers (inspection_id, position, item_code, group_label, item_label, essential, answer, comment, priority, delay)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [p.id, position++, item.code, g.label, item.label, !!item.essential, a.answer, a.comment, anomaly ? a.priority : null, a.answer === "intervention" ? a.delay : null], db);
      if (anomaly) {
        const issue = await q1<{ id: string }>(
          `insert into issues (vehicle_id, inspection_id, answer_id, title, description, severity, priority, delay, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
          [vehicle.id, p.id, answer!.id, `${g.label} — ${item.label}`, a.comment, a.answer, a.priority, a.answer === "intervention" ? a.delay : null, user.id], db);
        // Une intervention nécessaire ouvre directement une réparation « À chiffrer », liée à l'anomalie.
        if (a.answer === "intervention")
          await q(`insert into repairs (vehicle_id, issue_id, title, description, urgent, created_by) values ($1,$2,$3,$4,$5,$6)`,
            [vehicle.id, issue!.id, `${g.label} — ${item.label}`, a.comment, a.priority === "urgente", user.id], db);
      }
      let n = 0;
      for (const photoId of a.photoIds ?? []) {
        n++;
        await q(`insert into documents (id, kind, vehicle_id, inspection_id, item_code, filename, mime, size_bytes, target, created_by)
                 select id, 'photo', $2, $3, $4, $5, mime, size_bytes, 'controles', $6 from staged_uploads where id = $1`,
          [photoId, vehicle.id, p.id, item.code, photoFilename(vehicle.plate, now, p.id, item.code, n), user.id], db);
        await q("insert into document_blobs (document_id, data) select id, data from staged_uploads where id = $1", [photoId], db);
        await q("insert into drive_jobs (document_id) values ($1)", [photoId], db);
      }
    }
    await q("delete from staged_uploads where id = any($1::uuid[])", [photoIds], db);

    const report = await q1<{ id: string }>(
      `insert into documents (kind, vehicle_id, inspection_id, version, filename, mime, target, created_by)
       values ('rapport_controle', $1, $2, 1, $3, 'application/pdf', 'controles', $4) returning id`,
      [vehicle.id, p.id, reportFilename(vehicle.plate, now, p.id, 1), user.id], db);
    await q("insert into drive_jobs (document_id) values ($1)", [report!.id], db);

    if (p.proposeImmobilization)
      await q("insert into immobilizations (vehicle_id, inspection_id, reason, proposed_by) values ($1,$2,$3,$4)", [vehicle.id, p.id, p.criticalComment, user.id], db);

    await audit(db, user.id, "controle_valide", "inspection", p.id, { vehicule: vehicle.plate, km: p.mileageKm, synthese: summary, photos: photoIds.length });
    return { id: p.id, duplicate: false };
  });
}

const correctionPayload = z.object({
  mileageKm: z.number().int().min(0).max(2_000_000),
  generalComment: text(2000),
  reason: z.string().trim().min(3, "Le motif de la correction est obligatoire.").max(500),
});

/**
 * Correction d'un contrôle : tracée (avant / après / motif) et versionnée. Le rapport précédent
 * est conservé tel quel ; un nouveau rapport _v2, _v3… est déposé à côté.
 */
export async function correctInspection(user: User, inspectionId: string, input: unknown): Promise<{ version: number; changed: boolean }> {
  if (!can(user.role, "inspection.correct")) throw new ApiError(403, "Action non autorisée pour votre rôle.");
  const parsed = correctionPayload.safeParse(input);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0].message);
  const p = parsed.data;
  return tx(async (db) => {
    const i = await q1<{ id: string; vehicle_id: string; author_id: string; mileage_km: number; general_comment: string | null; version: number; performed_at: Date; plate: string }>(
      "select i.*, v.plate from inspections i join vehicles v on v.id = i.vehicle_id where i.id = $1 for update of i", [inspectionId], db);
    if (!i || !(await canAccessVehicle(user, i.vehicle_id))) throw new ApiError(404, "Contrôle introuvable.");
    if (user.role === "technicien" && i.author_id !== user.id) throw new ApiError(403, "Vous ne pouvez corriger que vos propres contrôles.");
    const before = { km: i.mileage_km, commentaire: i.general_comment };
    const after = { km: p.mileageKm, commentaire: p.generalComment };
    if (before.km === after.km && before.commentaire === after.commentaire) return { version: i.version, changed: false };

    // Fige les rapports des versions précédentes pas encore déposés, avant de modifier les données.
    const pending = await q<{ id: string; kind: string; inspection_id: string }>(
      "select id, kind, inspection_id from documents where inspection_id = $1 and kind = 'rapport_controle' and sync_status = 'en_attente'", [i.id], db);
    for (const doc of pending) await materializeBlob(db, doc);

    const version = i.version + 1;
    await q("update inspections set mileage_km = $2, general_comment = $3, version = $4 where id = $1", [i.id, p.mileageKm, p.generalComment, version], db);
    await audit(db, user.id, "correction", "inspection", i.id, { motif: p.reason, avant: before, apres: after, version });
    const report = await q1<{ id: string }>(
      `insert into documents (kind, vehicle_id, inspection_id, version, filename, mime, target, created_by)
       values ('rapport_controle', $1, $2, $3, $4, 'application/pdf', 'controles', $5) returning id`,
      [i.vehicle_id, i.id, version, reportFilename(i.plate, i.performed_at, i.id, version), user.id], db);
    await q("insert into drive_jobs (document_id) values ($1)", [report!.id], db);
    return { version, changed: true };
  });
}
