import { notFound, redirect } from "next/navigation";
import { canAccessVehicle, requireUser } from "@/lib/auth";
import { q1 } from "@/lib/db";
import { can } from "@/lib/permissions";

// Cible des QR codes collés dans les véhicules. Le QR code ne contient que la plaque :
// la connexion et les droits restent exigés.
export default async function QrEntry({ params }: { params: Promise<{ plate: string }> }) {
  const user = await requireUser();
  const { plate } = await params;
  const v = await q1<{ id: string; status: string }>("select id, status from vehicles where plate = $1", [decodeURIComponent(plate).toUpperCase()]);
  if (!v || !(await canAccessVehicle(user, v.id))) notFound();
  redirect(can(user.role, "inspection.create") && v.status === "actif" ? `/controle/${v.id}` : `/vehicules/${v.id}`);
}
