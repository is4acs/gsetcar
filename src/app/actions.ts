"use server";
// Actions serveur des formulaires. Chaque action revérifie l'identité, le rôle et le périmètre.
import { redirect } from "next/navigation";
import { after } from "next/server";
import { ApiError, apiUser, assertVehicleAccess, type User } from "@/lib/auth";
import { audit, q, q1, tx } from "@/lib/db";
import { can, ROLES, type Permission, type Role } from "@/lib/permissions";
import { checkTransition, REPAIR_STATUSES, VALIDATED_STATUSES, type RepairStatus } from "@/lib/repair-status";
import { parseMoney } from "@/lib/format";
import { repairDocFilename } from "@/lib/naming";
import { correctInspection } from "@/lib/inspections";
import { retryJobs, runDriveJobs, verifyVehicleFolder } from "@/lib/jobs";

const str = (f: FormData, k: string, max = 2000) => String(f.get(k) ?? "").trim().slice(0, max);
const opt = (f: FormData, k: string, max = 2000) => str(f, k, max) || null;
const uuid = (f: FormData, k: string) => { const v = str(f, k); if (!/^[0-9a-f-]{36}$/.test(v)) throw new ApiError(422, "Identifiant invalide."); return v; };
const date = (f: FormData, k: string) => { const v = str(f, k); if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new ApiError(422, "Date invalide."); return v; };
const money = (f: FormData, k: string) => { const v = parseMoney(str(f, k)); if (v === undefined) throw new ApiError(422, "Montant invalide (exemple : 1234,50)."); return v; };

/** Exécute l'action puis revient sur la page avec un message ; les erreurs prévues sont affichées, pas levées. */
async function run(form: FormData, permission: Permission | null, fn: (user: User) => Promise<string | void>): Promise<never> {
  const back = str(form, "_back", 300);
  const path = back.startsWith("/") && !back.startsWith("//") ? back.split("?")[0] : "/";
  let target: string;
  try {
    const user = await apiUser(permission ?? undefined);
    const msg = await fn(user);
    target = msg?.startsWith("/") ? msg : `${path}?ok=${encodeURIComponent(msg ?? "1")}`;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401) redirect("/login");
      target = `${path}?err=${encodeURIComponent(e.message)}`;
    } else if ((e as { code?: string }).code === "23505") {
      target = `${path}?err=${encodeURIComponent("Déjà enregistré (doublon évité).")}`;
    } else throw e;
  }
  redirect(target);
}

async function loadRepair(user: User, id: string, db?: Parameters<typeof q>[2], lock = false) {
  const r = await q1<{ id: string; vehicle_id: string; issue_id: string | null; status: RepairStatus; estimate_ht_cents: number | null; estimate_ttc_cents: number | null; plate: string }>(
    `select r.id, r.vehicle_id, r.issue_id, r.status, r.estimate_ht_cents, r.estimate_ttc_cents, v.plate from repairs r join vehicles v on v.id = r.vehicle_id where r.id = $1 ${lock ? "for update of r" : ""}`, [id], db);
  if (!r) throw new ApiError(404, "Réparation introuvable.");
  await assertVehicleAccess(user, r.vehicle_id);
  return r;
}

// ------------------------------------------------------------------ Réparations

export async function createRepair(form: FormData) {
  return run(form, "repair.edit", async (user) => {
    const issueId = opt(form, "issueId");
    let vehicleId: string, title = str(form, "title", 200), description = opt(form, "description");
    if (issueId) {
      const issue = await q1<{ vehicle_id: string; title: string; description: string | null; priority: string }>("select vehicle_id, title, description, priority from issues where id = $1", [uuid(form, "issueId")]);
      if (!issue) throw new ApiError(404, "Anomalie introuvable.");
      vehicleId = issue.vehicle_id; title ||= issue.title; description ??= issue.description;
    } else vehicleId = uuid(form, "vehicleId");
    await assertVehicleAccess(user, vehicleId);
    if (!title) throw new ApiError(422, "Indiquez l'objet de la réparation.");
    const r = await q1<{ id: string }>("insert into repairs (vehicle_id, issue_id, title, description, urgent, created_by) values ($1,$2,$3,$4,$5,$6) returning id",
      [vehicleId, issueId, title, description, form.get("urgent") === "on", user.id]);
    await audit(undefined, user.id, "reparation_creee", "repair", r!.id, { titre: title, anomalie: issueId });
    return `/reparations/${r!.id}?ok=${encodeURIComponent("Réparation créée.")}`;
  });
}

export async function updateRepair(form: FormData) {
  return run(form, "repair.edit", async (user) => {
    const id = uuid(form, "id");
    await tx(async (db) => {
      const r = await loadRepair(user, id, db, true);
      if (["termine", "annule"].includes(r.status) && !can(user.role, "repair.validate")) throw new ApiError(403, "Réparation close : modification réservée à la direction.");
      let estHt = money(form, "estimate_ht"), estTtc = money(form, "estimate_ttc");
      // Une fois la dépense validée, le montant estimé ne peut plus être modifié que par la direction.
      if ([...VALIDATED_STATUSES, "a_valider"].includes(r.status) && !can(user.role, "repair.edit_validated_estimate")) {
        if (estHt !== r.estimate_ht_cents || estTtc !== r.estimate_ttc_cents) throw new ApiError(403, "Le montant estimé est verrouillé : il est soumis à validation ou déjà validé. Repassez par la direction.");
        estHt = r.estimate_ht_cents; estTtc = r.estimate_ttc_cents;
      }
      const fields = {
        title: str(form, "title", 200) || undefined, description: opt(form, "description"), garage: opt(form, "garage", 200), urgent: form.get("urgent") === "on",
        estimate_ht_cents: estHt, estimate_ttc_cents: estTtc, actual_ht_cents: money(form, "actual_ht"), actual_ttc_cents: money(form, "actual_ttc"),
        quote_received_on: date(form, "quote_received_on"), planned_on: date(form, "planned_on"), started_on: date(form, "started_on"), completed_on: date(form, "completed_on"),
      };
      for (const [ht, ttc] of [[fields.estimate_ht_cents, fields.estimate_ttc_cents], [fields.actual_ht_cents, fields.actual_ttc_cents]])
        if (ht != null && ttc != null && ttc < ht) throw new ApiError(422, "Le montant TTC ne peut pas être inférieur au HT.");
      await q(`update repairs set title = coalesce($2, title), description = $3, garage = $4, urgent = $5, estimate_ht_cents = $6, estimate_ttc_cents = $7, actual_ht_cents = $8, actual_ttc_cents = $9,
               quote_received_on = $10, planned_on = $11, started_on = $12, completed_on = $13, updated_at = now() where id = $1`,
        [id, fields.title ?? null, fields.description, fields.garage, fields.urgent, fields.estimate_ht_cents, fields.estimate_ttc_cents, fields.actual_ht_cents, fields.actual_ttc_cents,
          fields.quote_received_on, fields.planned_on, fields.started_on, fields.completed_on], db);
      await audit(db, user.id, "reparation_modifiee", "repair", id, fields);
    });
  });
}

export async function transitionRepair(form: FormData) {
  return run(form, "repair.edit", async (user) => {
    const id = uuid(form, "id");
    const to = str(form, "to") as RepairStatus;
    const reason = opt(form, "reason", 500);
    if (!REPAIR_STATUSES.includes(to)) throw new ApiError(422, "Statut inconnu.");
    await tx(async (db) => {
      const r = await loadRepair(user, id, db, true);
      if (r.status === to) return; // double clic
      const error = checkTransition(user.role, r.status, to, reason);
      if (error) throw new ApiError(to === "valide" || to === "refuse" ? 403 : 422, error);
      if (to === "a_valider" && r.estimate_ht_cents == null && r.estimate_ttc_cents == null) throw new ApiError(422, "Renseignez et enregistrez un montant estimé (HT ou TTC) avant de demander la validation.");
      const validating = r.status === "a_valider" && to === "valide";
      await q(`update repairs set status = $2, status_reason = case when $3::text is not null then $3 else status_reason end,
               validated_by = case when $4 then $5::uuid when $2 in ('a_chiffrer','devis_recu','a_valider','refuse') then null else validated_by end,
               validated_at = case when $4 then now() when $2 in ('a_chiffrer','devis_recu','a_valider','refuse') then null else validated_at end,
               quote_received_on = case when $2 = 'devis_recu' then coalesce(quote_received_on, current_date) else quote_received_on end,
               started_on = case when $2 = 'en_cours' then coalesce(started_on, current_date) else started_on end,
               completed_on = case when $2 = 'termine' then coalesce(completed_on, current_date) else completed_on end,
               updated_at = now() where id = $1`, [id, to, reason, validating, user.id], db);
      // Terminer une réparation ne clôt que l'anomalie qui lui est liée, jamais les autres anomalies du véhicule.
      if (to === "termine" && r.issue_id)
        await q("update issues set status = 'resolue', closed_at = now(), closed_by = $2, close_reason = 'Réparation terminée' where id = $1 and status = 'ouverte'", [r.issue_id, user.id], db);
      await audit(db, user.id, "reparation_statut", "repair", id, { de: r.status, vers: to, motif: reason, estime_ht: r.estimate_ht_cents, estime_ttc: r.estimate_ttc_cents });
    });
  });
}

const MAGIC: [string, number[]][] = [["application/pdf", [0x25, 0x50, 0x44, 0x46]], ["image/jpeg", [0xff, 0xd8, 0xff]], ["image/png", [0x89, 0x50, 0x4e, 0x47]]];

export async function uploadRepairDocument(form: FormData) {
  return run(form, "repair.edit", async (user) => {
    const repairId = uuid(form, "id"), docId = uuid(form, "docId");
    const kind = str(form, "kind");
    if (kind !== "devis" && kind !== "facture") throw new ApiError(422, "Type de document inconnu.");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ApiError(422, "Choisissez un fichier.");
    if (file.size > 4 * 1024 * 1024) throw new ApiError(413, "Fichier trop volumineux (4 Mo maximum).");
    const data = Buffer.from(await file.arrayBuffer());
    const mime = MAGIC.find(([, sig]) => sig.every((b, i) => data[i] === b))?.[0];
    if (!mime) throw new ApiError(422, "Format non accepté : PDF, JPEG ou PNG uniquement.");
    await tx(async (db) => {
      const r = await loadRepair(user, repairId, db, true);
      if (await q1("select 1 from documents where id = $1", [docId], db)) return; // formulaire renvoyé deux fois
      const n = (await q1<{ n: number }>("select count(*)::int + 1 as n from documents where repair_id = $1 and kind = $2", [repairId, kind], db))!.n;
      const filename = repairDocFilename(kind, r.plate, new Date(), repairId, n, mime === "application/pdf" ? "x.pdf" : mime === "image/png" ? "x.png" : "x.jpg");
      await q(`insert into documents (id, kind, vehicle_id, repair_id, filename, mime, size_bytes, target, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [docId, kind, r.vehicle_id, repairId, filename, mime, data.length, kind === "facture" ? "factures" : "racine", user.id], db);
      await q("insert into document_blobs (document_id, data) values ($1,$2)", [docId, data], db);
      await q("insert into drive_jobs (document_id) values ($1)", [docId], db);
      await audit(db, user.id, "document_ajoute", "repair", repairId, { type: kind, fichier: filename, nom_origine: file.name.slice(0, 200) });
    });
    after(() => runDriveJobs({ budgetMs: 25_000 }).catch((e) => console.error(e)));
    return kind === "facture" ? "Facture enregistrée, dépôt Drive en cours." : "Devis enregistré, dépôt Drive en cours.";
  });
}

// ------------------------------------------------------------------ Anomalies, immobilisation, urgences

export async function closeIssue(form: FormData) {
  return run(form, "issue.close", async (user) => {
    const reason = str(form, "reason", 500);
    if (!reason) throw new ApiError(422, "Un motif est obligatoire pour classer une anomalie.");
    const rows = await q("update issues set status = 'classee', closed_at = now(), closed_by = $2, close_reason = $3 where id = $1 and status = 'ouverte' returning id", [uuid(form, "id"), user.id, reason]);
    if (rows.length) await audit(undefined, user.id, "anomalie_classee", "issue", str(form, "id"), { motif: reason });
  });
}

export async function proposeImmobilization(form: FormData) {
  return run(form, "immobilization.propose", async (user) => {
    const vehicleId = uuid(form, "vehicleId");
    await assertVehicleAccess(user, vehicleId);
    const reason = str(form, "reason", 1000);
    if (!reason) throw new ApiError(422, "Indiquez le motif de l'immobilisation proposée.");
    await tx(async (db) => {
      await q("select 1 from vehicles where id = $1 for update", [vehicleId], db);
      if (await q1("select 1 from immobilizations where vehicle_id = $1 and status in ('proposee','active')", [vehicleId], db)) throw new ApiError(422, "Une immobilisation est déjà proposée ou en cours pour ce véhicule.");
      const m = await q1<{ id: string }>("insert into immobilizations (vehicle_id, repair_id, reason, proposed_by) values ($1,$2,$3,$4) returning id", [vehicleId, opt(form, "repairId"), reason, user.id], db);
      await audit(db, user.id, "immobilisation_proposee", "immobilization", m!.id, { motif: reason });
    });
    return "Proposition d'immobilisation transmise à la direction.";
  });
}

export async function decideImmobilization(form: FormData) {
  return run(form, "immobilization.decide", async (user) => {
    const accept = str(form, "decision") === "accepter";
    const rows = await q("update immobilizations set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1 and status = 'proposee' returning id",
      [uuid(form, "id"), accept ? "active" : "rejetee", user.id, opt(form, "note", 1000)]);
    if (rows.length) await audit(undefined, user.id, accept ? "immobilisation_decidee" : "immobilisation_rejetee", "immobilization", str(form, "id"), { note: opt(form, "note", 1000) });
  });
}

/** Immobilisation décidée directement par la direction, sans proposition préalable. */
export async function immobilizeNow(form: FormData) {
  return run(form, "immobilization.decide", async (user) => {
    const vehicleId = uuid(form, "vehicleId");
    const reason = str(form, "reason", 1000);
    if (!reason) throw new ApiError(422, "Indiquez le motif de l'immobilisation.");
    await tx(async (db) => {
      await q("select 1 from vehicles where id = $1 for update", [vehicleId], db);
      if (await q1("select 1 from immobilizations where vehicle_id = $1 and status = 'active'", [vehicleId], db)) throw new ApiError(422, "Ce véhicule est déjà immobilisé.");
      const m = await q1<{ id: string }>("insert into immobilizations (vehicle_id, reason, status, proposed_by, decided_by, decided_at) values ($1,$2,'active',$3,$3,now()) returning id", [vehicleId, reason, user.id], db);
      await audit(db, user.id, "immobilisation_decidee", "immobilization", m!.id, { motif: reason });
    });
  });
}

export async function releaseImmobilization(form: FormData) {
  return run(form, "immobilization.decide", async (user) => {
    const note = str(form, "note", 1000);
    if (!note) throw new ApiError(422, "Indiquez sur quelle base le véhicule est remis en service.");
    const rows = await q("update immobilizations set status = 'levee', released_by = $2, released_at = now(), release_note = $3 where id = $1 and status = 'active' returning id", [uuid(form, "id"), user.id, note]);
    if (rows.length) await audit(undefined, user.id, "remise_en_service", "immobilization", str(form, "id"), { note });
  });
}

export async function acknowledgeCritical(form: FormData) {
  return run(form, "immobilization.decide", async (user) => {
    const rows = await q("update inspections set critical_ack_by = $2, critical_ack_at = now() where id = $1 and critical_flag and critical_ack_at is null returning id", [uuid(form, "id"), user.id]);
    if (rows.length) await audit(undefined, user.id, "critique_pris_en_compte", "inspection", str(form, "id"));
  });
}

export async function correctInspectionAction(form: FormData) {
  return run(form, "inspection.correct", async (user) => {
    const km = str(form, "mileageKm");
    if (!/^\d{1,7}$/.test(km)) throw new ApiError(422, "Kilométrage invalide.");
    const res = await correctInspection(user, uuid(form, "id"), { mileageKm: Number(km), generalComment: str(form, "generalComment"), reason: str(form, "reason") });
    if (!res.changed) return "Aucune modification.";
    after(() => runDriveJobs({ budgetMs: 25_000 }).catch((e) => console.error(e)));
    return `Correction enregistrée (version ${res.version}). Un nouveau rapport est déposé à côté du précédent.`;
  });
}

// ------------------------------------------------------------------ Véhicules

export async function updateVehicle(form: FormData) {
  return run(form, "vehicle.edit", async (user) => {
    const id = uuid(form, "id");
    const fields = { site: opt(form, "site", 100), assignment: opt(form, "assignment", 200), notes: opt(form, "notes") };
    await q("update vehicles set site = $2, assignment = $3, notes = $4 where id = $1", [id, fields.site, fields.assignment, fields.notes]);
    await audit(undefined, user.id, "vehicule_modifie", "vehicle", id, fields);
  });
}

export async function setVehicleStatus(form: FormData) {
  return run(form, "vehicle.status", async (user) => {
    const id = uuid(form, "id"), status = str(form, "status");
    if (!["actif", "a_confirmer", "vendu"].includes(status)) throw new ApiError(422, "Statut inconnu.");
    await q("update vehicles set status = $2, status_confirmed_at = case when $2 = 'a_confirmer' then null else now() end, status_confirmed_by = case when $2 = 'a_confirmer' then null else $3::uuid end where id = $1", [id, status, user.id]);
    await audit(undefined, user.id, "vehicule_statut", "vehicle", id, { statut: status });
    return "Statut du véhicule confirmé.";
  });
}

export async function addDeadline(form: FormData) {
  return run(form, "vehicle.edit", async (user) => {
    const vehicleId = uuid(form, "vehicleId"), kind = str(form, "kind"), due = date(form, "due_on"), source = str(form, "source", 300);
    if (!["ct", "assurance", "entretien", "autre"].includes(kind)) throw new ApiError(422, "Type d'échéance inconnu.");
    if (!due) throw new ApiError(422, "Indiquez la date d'échéance.");
    if (!source) throw new ApiError(422, "Indiquez d'où vient cette date (document, garage, assureur…).");
    await tx(async (db) => {
      if (kind !== "autre") await q("update vehicle_deadlines set superseded_at = now() where vehicle_id = $1 and kind = $2 and superseded_at is null", [vehicleId, kind], db);
      await q("insert into vehicle_deadlines (vehicle_id, kind, due_on, source, note, created_by) values ($1,$2,$3,$4,$5,$6)", [vehicleId, kind, due, source, opt(form, "note", 500), user.id], db);
      await audit(db, user.id, "echeance_ajoutee", "vehicle", vehicleId, { type: kind, date: due, provenance: source });
    });
  });
}

// ------------------------------------------------------------------ Envois Drive

export async function retryJobAction(form: FormData) {
  return run(form, "jobs.manage", async (user) => {
    const n = await retryJobs(user.id, opt(form, "id") ?? undefined);
    const r = await runDriveJobs({ budgetMs: 20_000 });
    return `${n} envoi(s) relancé(s) : ${r.done} déposé(s), ${r.retry + r.failed} en erreur, ${r.blocked} bloqué(s).`;
  });
}

// ------------------------------------------------------------------ Administration

export async function saveUser(form: FormData) {
  return run(form, "admin.manage", async (user) => {
    const email = str(form, "email", 200).toLowerCase(), name = str(form, "name", 100), role = str(form, "role") as Role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, "Adresse e-mail invalide.");
    if (!name) throw new ApiError(422, "Indiquez le nom.");
    if (!ROLES.includes(role)) throw new ApiError(422, "Rôle inconnu.");
    if (email === user.email && role !== "admin") throw new ApiError(422, "Vous ne pouvez pas retirer votre propre rôle d'administrateur.");
    const u = await q1<{ id: string }>("insert into users (email, name, role) values ($1,$2,$3) on conflict (email) do update set name = excluded.name, role = excluded.role returning id", [email, name, role]);
    await audit(undefined, user.id, "utilisateur_enregistre", "user", u!.id, { email, role });
  });
}

export async function setUserActive(form: FormData) {
  return run(form, "admin.manage", async (user) => {
    const id = uuid(form, "id"), active = str(form, "active") === "true";
    if (id === user.id) throw new ApiError(422, "Vous ne pouvez pas désactiver votre propre compte.");
    await q("update users set active = $2 where id = $1", [id, active]);
    await audit(undefined, user.id, active ? "utilisateur_reactive" : "utilisateur_desactive", "user", id);
  });
}

export async function setUserScope(form: FormData) {
  return run(form, "admin.manage", async (user) => {
    const id = uuid(form, "id");
    const vehicleIds = form.getAll("vehicleIds").map(String).filter((v) => /^[0-9a-f-]{36}$/.test(v));
    await tx(async (db) => {
      await q("delete from user_vehicle_scope where user_id = $1", [id], db);
      for (const v of vehicleIds) await q("insert into user_vehicle_scope (user_id, vehicle_id) values ($1,$2)", [id, v], db);
      await audit(db, user.id, "perimetre_modifie", "user", id, { vehicules: vehicleIds });
    });
    return vehicleIds.length ? "Périmètre limité aux véhicules cochés." : "Périmètre : tout le parc.";
  });
}

export async function addVehicle(form: FormData) {
  return run(form, "admin.manage", async (user) => {
    const plate = str(form, "plate", 20).toUpperCase(), label = str(form, "label", 100);
    if (!/^[A-Z0-9][A-Z0-9-]{3,14}$/.test(plate) || !label) throw new ApiError(422, "Immatriculation ou modèle invalide.");
    const v = await q1<{ id: string }>("insert into vehicles (plate, label, nacelle, status) values ($1,$2,$3,'a_confirmer') returning id", [plate, label, form.get("nacelle") === "on"]);
    await audit(undefined, user.id, "vehicule_ajoute", "vehicle", v!.id, { plaque: plate });
    return "Véhicule ajouté avec le statut « à confirmer ».";
  });
}

export async function setVehicleFolder(form: FormData) {
  return run(form, "admin.manage", async (user) => {
    const id = uuid(form, "id");
    // Accepte l'identifiant seul ou l'adresse complète du dossier.
    const raw = str(form, "folder", 300);
    const folderId = raw.match(/folders\/([\w-]{10,})/)?.[1] ?? raw;
    if (!/^[\w-]{10,}$/.test(folderId)) throw new ApiError(422, "Identifiant de dossier Drive invalide.");
    const changed = await q("update vehicles set drive_folder_id = $2, drive_folder_name = null, drive_folder_verified_at = null, drive_controles_folder_id = null, drive_factures_folder_id = null where id = $1 and drive_folder_id is distinct from $2 returning id", [id, folderId]);
    if (changed.length) await audit(undefined, user.id, "dossier_drive_associe", "vehicle", id, { dossier: folderId });
    const res = await verifyVehicleFolder(user.id, id);
    if (!res.ok) throw new ApiError(422, res.message);
    return res.message;
  });
}

export async function verifyFolderAction(form: FormData) {
  return run(form, "admin.manage", async (user) => {
    const res = await verifyVehicleFolder(user.id, uuid(form, "id"));
    if (!res.ok) throw new ApiError(422, res.message);
    return res.message;
  });
}

export async function saveInterval(form: FormData) {
  return run(form, "admin.manage", async (user) => {
    const raw = str(form, "days");
    if (raw === "") {
      await q("delete from settings where key = 'periodicite_controle_jours'");
    } else {
      if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1) throw new ApiError(422, "Nombre de jours invalide.");
      await q("insert into settings (key, value, updated_by) values ('periodicite_controle_jours', $1, $2) on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by", [JSON.stringify(Number(raw)), user.id]);
    }
    await audit(undefined, user.id, "periodicite_modifiee", "settings", "periodicite_controle_jours", { jours: raw || null });
  });
}
