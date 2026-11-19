import { after } from "next/server";
import { q1 } from "./db";
import { runDriveJobs } from "./jobs";

/**
 * Lance le traitement des envois Drive arrivés à échéance, après la réponse en cours.
 * Complète la tâche planifiée : sur une offre Vercel limitée à une exécution par jour, les envois en attente
 * repartent dès que quelqu'un utilise l'application. Sans effet s'il n'y a rien à traiter.
 */
export async function kickDriveJobs(): Promise<void> {
  const due = await q1(
    "select 1 from drive_jobs where (status in ('en_attente','bloque') and next_attempt_at <= now()) or (status = 'en_cours' and locked_until < now()) limit 1").catch(() => null);
  if (due) after(() => runDriveJobs({ budgetMs: 20_000, limit: 10 }).catch((e) => console.error(e)));
}
