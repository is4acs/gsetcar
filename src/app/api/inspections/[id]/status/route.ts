import { ApiError, apiHandler, apiUser, assertVehicleAccess } from "@/lib/auth";
import { q, q1 } from "@/lib/db";
import { kickDriveJobs } from "@/lib/kick";

// État de synchronisation des documents d'un contrôle (interrogé par l'écran de suivi).
export const GET = apiHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await apiUser();
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError(404, "Contrôle introuvable.");
  const insp = await q1<{ vehicle_id: string }>("select vehicle_id from inspections where id = $1", [id]);
  if (!insp) throw new ApiError(404, "Contrôle introuvable.");
  await assertVehicleAccess(user, insp.vehicle_id);
  const documents = await q(
    `select d.id, d.kind, d.filename, d.version, d.sync_status, j.status as job_status, j.last_error, j.next_attempt_at
     from documents d left join drive_jobs j on j.document_id = d.id where d.inspection_id = $1 order by d.kind desc, d.version, d.filename`, [id]);
  await kickDriveJobs(); // l'écran de suivi relance les envois arrivés à échéance
  return Response.json({ documents });
});
