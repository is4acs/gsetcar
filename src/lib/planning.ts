// Planning mensuel du classeur : chaque véhicule contrôlé une fois par mois, deux véhicules par semaine (S1 à S4).
import { q } from "./db";
import { planningStatus, weekOfMonth, type PlanningStatus } from "./checklist";
import { addMonths, localParts } from "./format";

const TZ = process.env.NEXT_PUBLIC_APP_TIMEZONE || "America/Cayenne";
/** Premier mois du planning (classeur : novembre 2026). Les mois antérieurs ne sont jamais comptés « en retard ». */
export const PLANNING_START = process.env.PLANNING_START_MONTH || "2026-11";

export type VehiclePlanning = {
  done: Set<string>;            // mois « AAAA-MM » avec au moins un contrôle enregistré
  lateMonths: string[];         // mois passés sans contrôle depuis le début du planning
  current: { status: PlanningStatus; label: string; tone: "green" | "amber" | "red" | "gray"; due: boolean };
};

/** Mois contrôlés par véhicule. */
export async function doneMonths(vehicleIds: string[]): Promise<Map<string, Set<string>>> {
  const rows = await q<{ vehicle_id: string; month: string }>(
    `select distinct vehicle_id, to_char(performed_at at time zone $2, 'YYYY-MM') as month from inspections where vehicle_id = any($1)`, [vehicleIds, TZ]);
  const map = new Map<string, Set<string>>();
  for (const r of rows) (map.get(r.vehicle_id) ?? map.set(r.vehicle_id, new Set()).get(r.vehicle_id)!).add(r.month);
  return map;
}

export function vehiclePlanning(week: number | null, done: Set<string>, now: Date = new Date()): VehiclePlanning {
  const { month, dayOfMonth } = localParts(now);
  const lateMonths: string[] = [];
  for (let m = PLANNING_START; m < month; m = addMonths(m, 1)) if (!done.has(m)) lateMonths.push(m);
  const thisWeek = weekOfMonth(dayOfMonth);
  let current: VehiclePlanning["current"];
  if (month < PLANNING_START) current = { status: "a_faire", label: "Planning non commencé", tone: "gray", due: false };
  else if (done.has(month)) current = { status: "fait", label: "Fait ce mois", tone: "green", due: false };
  else if (!week) current = { status: "a_faire", label: "À faire ce mois (semaine non définie)", tone: "amber", due: true };
  else if (week < thisWeek) current = { status: "a_faire", label: `Semaine prévue dépassée (S${week})`, tone: "red", due: true };
  else if (week === thisWeek) current = { status: "a_faire", label: `Prévu cette semaine (S${week})`, tone: "amber", due: true };
  else current = { status: "a_faire", label: `Prévu en S${week}`, tone: "gray", due: false };
  return { done, lateMonths, current };
}

/** Grille « véhicule × mois » comme l'onglet Planning : 12 mois à partir du début du planning (fenêtre glissante ensuite). */
export function planningMonths(now: Date = new Date()): string[] {
  const { month } = localParts(now);
  let start = PLANNING_START;
  while (addMonths(start, 11) < addMonths(month, 3)) start = addMonths(start, 1);
  return Array.from({ length: 12 }, (_, n) => addMonths(start, n));
}

export { planningStatus };
