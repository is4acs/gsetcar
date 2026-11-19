import { ApiError, apiHandler, apiUser } from "@/lib/auth";
import { q, q1 } from "@/lib/db";

const MAX = 3 * 1024 * 1024;

// Réception d'une photo compressée par le téléphone, avant la validation du contrôle.
// Rejouable : l'identifiant vient du téléphone, un second envoi est sans effet.
export const POST = apiHandler(async (req) => {
  const user = await apiUser("inspection.create");
  const form = await req.formData();
  const id = String(form.get("id") ?? "");
  const file = form.get("file");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || !(file instanceof File)) throw new ApiError(422, "Envoi invalide.");
  if (file.size === 0 || file.size > MAX) throw new ApiError(413, "Photo trop volumineuse (3 Mo maximum après compression).");
  const data = Buffer.from(await file.arrayBuffer());
  if (!(data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)) throw new ApiError(422, "Seules les photos JPEG sont acceptées.");
  const pending = await q1<{ n: number }>("select count(*)::int as n from staged_uploads where uploader_id = $1", [user.id]);
  if ((pending?.n ?? 0) >= 200) throw new ApiError(429, "Trop de photos en attente.");
  await q("insert into staged_uploads (id, uploader_id, mime, size_bytes, data) values ($1,$2,'image/jpeg',$3,$4) on conflict (id) do nothing", [id, user.id, data.length, data]);
  // Déjà rattachée à un contrôle validé (rejeu tardif) ou en attente pour cet utilisateur : dans les deux cas, c'est bon.
  const ok = await q1("select 1 from staged_uploads where id = $1 and uploader_id = $2 union all select 1 from documents where id = $1 and created_by = $2", [id, user.id]);
  if (!ok) throw new ApiError(409, "Identifiant de photo déjà utilisé.");
  return Response.json({ id });
});
