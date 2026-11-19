import { ApiError, apiHandler, apiUser, assertVehicleAccess } from "@/lib/auth";
import { q1 } from "@/lib/db";
import { materializeBlob } from "@/lib/jobs";

// Accès privé à un document : après contrôle des droits, renvoie vers Drive s'il y est déposé
// (Drive applique alors ses propres droits), sinon sert la copie temporaire en attente.
export const GET = apiHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await apiUser();
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError(404, "Document introuvable.");
  const doc = await q1<{ id: string; kind: string; vehicle_id: string; inspection_id: string | null; filename: string; mime: string; sync_status: string; drive_web_link: string | null }>(
    "select id, kind, vehicle_id, inspection_id, filename, mime, sync_status, drive_web_link from documents where id = $1", [id]);
  if (!doc) throw new ApiError(404, "Document introuvable.");
  await assertVehicleAccess(user, doc.vehicle_id);
  if (doc.sync_status === "depose") {
    if (doc.drive_web_link && /^https:\/\//.test(doc.drive_web_link)) return Response.redirect(doc.drive_web_link, 302);
    throw new ApiError(404, "Document déposé sur Drive, lien indisponible.");
  }
  const data = await materializeBlob(undefined, doc);
  return new Response(new Uint8Array(data), {
    headers: { "content-type": doc.mime, "content-disposition": `inline; filename="${doc.filename.replace(/[^\w.\-]/g, "_")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
});
