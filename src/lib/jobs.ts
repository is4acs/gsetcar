// File d'envoi durable vers Drive. Les travaux sont créés dans la même transaction que le contrôle ;
// ce module les exécute (cron Vercel + déclenchement après validation), avec reprises et anti-doublons.
import { audit, q, q1, tx, type Db } from "./db";
import { driveClient, DriveError, type DriveClient } from "./drive";
import { loadReportData, renderReport } from "./pdf";

type JobRow = { id: string; document_id: string; attempts: number; max_attempts: number };
type DocRow = {
  id: string; kind: string; vehicle_id: string; inspection_id: string | null; version: number; filename: string; mime: string;
  target: "racine" | "controles" | "factures"; sync_status: string; drive_file_id: string | null;
  plate: string; drive_folder_id: string | null; drive_folder_verified_at: Date | null; drive_controles_folder_id: string | null; drive_factures_folder_id: string | null;
};

class Blocked extends Error {}

const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** Délai avant la prochaine tentative : 1 min, 2, 4, 8… plafonné à 6 h. */
export function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 6 * 3600);
}

/**
 * Trouve ou crée un sous-dossier (Contrôles, Factures) et mémorise son identifiant.
 * Un verrou PostgreSQL par véhicule empêche deux traitements simultanés de créer deux dossiers.
 */
async function ensureSubfolder(drive: DriveClient, doc: DocRow, column: "drive_controles_folder_id" | "drive_factures_folder_id", name: string, matches: (n: string) => boolean): Promise<string> {
  return tx(async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`gset-folder:${doc.vehicle_id}:${column}`]);
    const current = await q1<Record<string, string | null>>(`select ${column} as id from vehicles where id = $1`, [doc.vehicle_id], db);
    if (current?.id) return current.id;
    const existing = (await drive.listChildFolders(doc.drive_folder_id!)).find((f) => matches(normalize(f.name)));
    const id = existing?.id ?? (await drive.createFolder(doc.drive_folder_id!, name)).id;
    await q(`update vehicles set ${column} = $1 where id = $2`, [id, doc.vehicle_id], db);
    await audit(db, null, existing ? "dossier_drive_reutilise" : "dossier_drive_cree", "vehicle", doc.vehicle_id, { dossier: name, id });
    return id;
  });
}

async function targetFolder(drive: DriveClient, doc: DocRow): Promise<string> {
  if (!doc.drive_folder_id) throw new Blocked(`Aucun dossier Drive associé au véhicule ${doc.plate}.`);
  if (!doc.drive_folder_verified_at) throw new Blocked(`Le dossier Drive du véhicule ${doc.plate} n'a pas encore été vérifié avec les accès de l'application.`);
  if (doc.target === "racine") return doc.drive_folder_id;
  if (doc.target === "controles") return doc.drive_controles_folder_id ?? ensureSubfolder(drive, doc, "drive_controles_folder_id", "Contrôles", (n) => n === "controles" || n === "controle");
  return doc.drive_factures_folder_id ?? ensureSubfolder(drive, doc, "drive_factures_folder_id", "Factures", (n) => n === "factures" || n === "facture");
}

/** Contenu du document : fichier en attente, ou PDF du rapport généré puis conservé jusqu'au dépôt. */
export async function materializeBlob(db: Db | undefined, doc: { id: string; kind: string; inspection_id: string | null }): Promise<Buffer> {
  const blob = await q1<{ data: Buffer }>("select data from document_blobs where document_id = $1", [doc.id], db);
  if (blob) return blob.data;
  if (doc.kind !== "rapport_controle" || !doc.inspection_id) throw new Error("Fichier en attente introuvable.");
  const data = await renderReport(await loadReportData(db, doc.inspection_id));
  await q("insert into document_blobs (document_id, data) values ($1,$2) on conflict (document_id) do nothing", [doc.id, data], db);
  await q("update documents set size_bytes = $2 where id = $1", [doc.id, data.length], db);
  return data;
}

async function processJob(drive: DriveClient, job: JobRow): Promise<void> {
  const doc = await q1<DocRow>(
    `select d.*, v.plate, v.drive_folder_id, v.drive_folder_verified_at, v.drive_controles_folder_id, v.drive_factures_folder_id
     from documents d join vehicles v on v.id = d.vehicle_id where d.id = $1`, [job.document_id]);
  if (!doc) throw new Error("Document introuvable.");
  let file = null as Awaited<ReturnType<DriveClient["getFile"]>>;
  if (doc.sync_status !== "depose") {
    const parentId = await targetFolder(drive, doc);
    const data = await materializeBlob(undefined, doc);
    // 1. Réserver l'identifiant Drive et l'enregistrer AVANT l'envoi.
    let fileId = doc.drive_file_id;
    if (!fileId) {
      fileId = await drive.generateId();
      await q("update documents set drive_file_id = $2 where id = $1 and drive_file_id is null", [doc.id, fileId]);
      fileId = (await q1<{ drive_file_id: string }>("select drive_file_id from documents where id = $1", [doc.id]))!.drive_file_id;
    }
    // 2. Si une tentative précédente a abouti sans que nous recevions la réponse, le fichier existe déjà.
    file = await drive.getFile(fileId);
    if (file?.trashed) throw new Blocked("Le fichier déposé a été mis à la corbeille dans Drive : à restaurer ou à traiter manuellement.");
    if (!file) {
      file = await drive.createFile({ id: fileId, name: doc.filename, parentId, mime: doc.mime, data, appProperties: { gsetDocumentId: doc.id, gsetVersion: String(doc.version) } });
      if (!file) file = await drive.getFile(fileId); // 409 : créé par une tentative concurrente
      if (!file) throw new Error("Drive signale un conflit d'identifiant mais le fichier est introuvable.");
    }
  }
  // 3. Confirmation : c'est seulement maintenant que le fichier temporaire est supprimé.
  await tx(async (db) => {
    if (file) await q("update documents set sync_status = 'depose', synced_at = now(), drive_web_link = $2 where id = $1", [doc.id, file.webViewLink], db);
    await q("delete from document_blobs where document_id = $1", [doc.id], db);
    await q("update drive_jobs set status = 'termine', finished_at = now(), locked_until = null, last_error = null, updated_at = now() where id = $1", [job.id], db);
    await audit(db, null, "document_depose", "document", doc.id, { fichier: doc.filename, drive_file_id: file?.id ?? doc.drive_file_id });
  });
}

export type RunResult = { claimed: number; done: number; retry: number; blocked: number; failed: number };

export async function runDriveJobs(opts: { limit?: number; budgetMs?: number } = {}): Promise<RunResult> {
  const started = Date.now();
  const result: RunResult = { claimed: 0, done: 0, retry: 0, blocked: 0, failed: 0 };
  const budget = opts.budgetMs ?? 45_000;
  let drive: DriveClient | null = null;
  let driveInitError: string | null = null;
  try { drive = driveClient(); } catch (e) { driveInitError = (e as Error).message; }

  for (let n = 0; n < (opts.limit ?? 25) && Date.now() - started < budget; n++) {
    // Réservation d'un travail à la fois : un traitement interrompu libère le travail à l'expiration du verrou.
    const job = await q1<JobRow>(
      `update drive_jobs set status = 'en_cours', locked_until = now() + interval '5 minutes', updated_at = now()
       where id = (select id from drive_jobs
                   where (status in ('en_attente','bloque') and next_attempt_at <= now()) or (status = 'en_cours' and locked_until < now())
                   order by next_attempt_at limit 1 for update skip locked)
       returning id, document_id, attempts, max_attempts`);
    if (!job) break;
    result.claimed++;
    try {
      if (!drive) throw new Blocked(driveInitError ?? "Drive non configuré.");
      await processJob(drive, job);
      result.done++;
    } catch (e) {
      const message = (e as Error).message?.slice(0, 500) || "Erreur inconnue";
      if (e instanceof Blocked || (e instanceof DriveError && e.blocking)) {
        // Accès ou configuration : pas de consommation de tentative, nouvelle vérification dans 15 minutes.
        await q("update drive_jobs set status = 'bloque', last_error = $2, next_attempt_at = now() + interval '15 minutes', locked_until = null, updated_at = now() where id = $1", [job.id, message]);
        result.blocked++;
      } else {
        const attempts = job.attempts + 1;
        const exhausted = attempts >= job.max_attempts;
        await q(`update drive_jobs set status = $2, attempts = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5), locked_until = null, updated_at = now() where id = $1`,
          [job.id, exhausted ? "echec" : "en_attente", attempts, message, backoffSeconds(attempts)]);
        if (exhausted) result.failed++; else result.retry++;
      }
    }
  }
  // Photos envoyées mais jamais rattachées à un contrôle validé : purge après 30 jours.
  await q("delete from staged_uploads where created_at < now() - interval '30 days'").catch(() => {});
  return result;
}

/** Reprise manuelle d'un envoi (ou de tous les envois en attente / en échec). */
export async function retryJobs(userId: string, jobId?: string): Promise<number> {
  const rows = await q(
    `update drive_jobs set status = 'en_attente', attempts = 0, next_attempt_at = now(), locked_until = null, updated_at = now()
     where status in ('en_attente','bloque','echec') and ($1::uuid is null or id = $1) returning id`, [jobId ?? null]);
  await audit(undefined, userId, "envoi_relance", "drive_job", jobId ?? null, { nombre: rows.length });
  return rows.length;
}

/** Vérifie, avec les accès de l'application, qu'un dossier existe et accepte les dépôts. */
export async function verifyVehicleFolder(userId: string, vehicleId: string): Promise<{ ok: boolean; message: string }> {
  const v = await q1<{ plate: string; drive_folder_id: string | null }>("select plate, drive_folder_id from vehicles where id = $1", [vehicleId]);
  if (!v?.drive_folder_id) return { ok: false, message: "Aucun identifiant de dossier renseigné." };
  let message: string, ok = false, name: string | null = null;
  try {
    const f = await driveClient().getFolder(v.drive_folder_id);
    if (!f) message = "Dossier introuvable ou non partagé avec l'application.";
    else if (!f.isFolder) message = "Cet identifiant ne désigne pas un dossier.";
    else if (f.trashed) message = "Ce dossier est dans la corbeille.";
    else if (!f.canAddChildren) message = `Dossier « ${f.name} » visible, mais l'application n'a pas le droit d'y déposer des fichiers.`;
    else { ok = true; name = f.name; message = `Dossier « ${f.name} » vérifié : dépôt autorisé.`; }
  } catch (e) {
    message = `Vérification impossible : ${(e as Error).message}`;
  }
  await q("update vehicles set drive_folder_verified_at = $2, drive_folder_name = coalesce($3, drive_folder_name) where id = $1", [vehicleId, ok ? new Date() : null, name]);
  await audit(undefined, userId, "dossier_drive_verification", "vehicle", vehicleId, { ok, message, dossier: v.drive_folder_id });
  if (ok) await q("update drive_jobs j set next_attempt_at = now() from documents d where d.id = j.document_id and d.vehicle_id = $1 and j.status = 'bloque'", [vehicleId]);
  return { ok, message };
}
