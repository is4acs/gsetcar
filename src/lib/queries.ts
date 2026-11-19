import { q, q1 } from "./db";
import { vehicleScope, type User } from "./auth";
import type { Summary } from "./checklist";

export type VehicleRow = {
  id: string; plate: string; label: string; nacelle: boolean; status: string; status_confirmed_at: Date | null; site: string | null; assignment: string | null; control_week: number | null;
  drive_folder_id: string | null; drive_folder_verified_at: Date | null;
  last_inspection_id: string | null; last_inspection_at: Date | null; last_summary: Summary | null; last_km: number | null;
  immobilized: boolean; immobilization_proposed: boolean; open_repairs: number;
};

/** Véhicules visibles par l'utilisateur, avec leur dernier contrôle. */
export async function listVehicles(user: User, opts: { activeOnly?: boolean } = {}): Promise<VehicleRow[]> {
  const scope = await vehicleScope(user.id, user.role);
  return q<VehicleRow>(
    `select v.id, v.plate, v.label, v.nacelle, v.status, v.status_confirmed_at, v.site, v.assignment, v.control_week, v.drive_folder_id, v.drive_folder_verified_at,
            li.id as last_inspection_id, li.performed_at as last_inspection_at, li.summary as last_summary,
            (select max(mileage_km) from inspections where vehicle_id = v.id) as last_km,
            exists(select 1 from immobilizations m where m.vehicle_id = v.id and m.status = 'active') as immobilized,
            exists(select 1 from immobilizations m where m.vehicle_id = v.id and m.status = 'proposee') as immobilization_proposed,
            (select count(*)::int from repairs r where r.vehicle_id = v.id and r.status not in ('termine','refuse','annule')) as open_repairs
     from vehicles v
     left join lateral (select id, performed_at, summary from inspections i where i.vehicle_id = v.id order by performed_at desc limit 1) li on true
     where ($1::uuid[] is null or v.id = any($1)) and ($2::boolean is not true or v.status = 'actif')
     order by v.status, v.plate`, [scope, !!opts.activeOnly]);
}

export async function getSetting<T>(key: string): Promise<T | null> {
  return (await q1<{ value: T }>("select value from settings where key = $1", [key]))?.value ?? null;
}
export type AlertContact = { name: string; phone: string | null };
/** Personne à prévenir par téléphone en cas d'immobilisation (classeur : Salim). Numéro saisi par l'administrateur. */
export async function alertContact(): Promise<AlertContact> {
  const c = await getSetting<Partial<AlertContact>>("contact_urgence");
  return { name: c?.name?.trim() || "Salim", phone: c?.phone?.trim() || null };
}
