import { after } from "next/server";
import { apiHandler, apiUser } from "@/lib/auth";
import { submitInspection } from "@/lib/inspections";
import { runDriveJobs } from "@/lib/jobs";

export const maxDuration = 60;

export const POST = apiHandler(async (req) => {
  const user = await apiUser("inspection.create");
  const result = await submitInspection(user, await req.json().catch(() => null));
  // Accélère le dépôt Drive. La garantie d'envoi repose sur la file en base et la tâche planifiée,
  // pas sur ce traitement qui peut être interrompu.
  after(() => runDriveJobs({ budgetMs: 25_000 }).catch((e) => console.error(e)));
  return Response.json(result);
});
