// Données de référence : véhicules issus du cadrage (statuts à confirmer) et premier administrateur.
// Idempotent : ne modifie jamais une ligne existante. Aucune intervention ni budget du classeur n'est importé.
import { pool } from "../src/lib/db";

// Les 8 véhicules du classeur Suivi_Parc_Auto_GSET.xlsx, avec leur semaine de contrôle (S1 à S4, onglet Planning) :
// utilisables, mais statut actif non confirmé. Les données nominatives (conducteurs, carte grise) ne sont pas
// dans le dépôt : elles se reprennent avec « npm run import:parc ».
// Les 2 véhicules vus uniquement dans Drive : 'a_confirmer', hors parc actif.
const VEHICLES: [plate: string, label: string, nacelle: boolean, status: string, folder: string | null, factures: string | null, week: number | null][] = [
  ["FA-763-MJ", "Citroën Jumper", false, "actif", "18bOgOVbezXAVyHNgv9FA_ScDmir5bknn", null, 1],
  ["DV-454-FA", "Peugeot Partner", false, "actif", null, null, 1], // dossier Drive à localiser
  ["CR-761-AW", "Renault Master / nacelle", true, "actif", "13oExZMet2T6NmQD9TM2dZTmRvdeiu2l1", null, 2],
  ["DQ-720-HZ", "Citroën C3", false, "actif", "1T8i3eLr_q-D0_k0ROQt_AvTWpw0fBW8t", null, 2],
  ["CD-736-LP", "Renault Master / nacelle", true, "actif", "1hgqd2tepQRg-JfqJ-7pK_DMXvl10Fb36", "19cH2GuE2kunWrJm8cMh_fupe5kS3cQeF", 3],
  ["CH-153-KE", "Mercedes Benz", false, "actif", "1SiALgH3E4qbg63MLePG_PLTWAEiJrfBG", null, 3],
  ["ER-011-NB", "Citroën Jumpy", false, "actif", "1bdj51cU1tpg0tYS0s7MxmjG94p8ZkDPV", null, 4],
  ["EP-315-FC", "Renault Master", false, "actif", "1B4XOWLXdv5W_8Wq6k2oB9ccKsGRolPWN", null, 4],
  ["FW-817-GY", "Citroën Jumpy (vu dans Drive)", false, "a_confirmer", "1FlGa6swBW9lL1VnY7wopgIdPd4pqdHzL", null, null],
  ["EP-602-EQ", "Dacia (vue dans Drive)", false, "a_confirmer", "1AA9Dudk7LW9R1DJ1TyXrg2Wtyw_SaiId", null, null],
];

async function main() {
  const db = pool();
  for (const [plate, label, nacelle, status, folder, factures, week] of VEHICLES) {
    await db.query(
      `insert into vehicles (plate, label, nacelle, status, drive_folder_id, drive_factures_folder_id, control_week)
       values ($1,$2,$3,$4,$5,$6,$7) on conflict (plate) do nothing`,
      [plate, label, nacelle, status, folder, factures, week]);
  }
  const admin = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (admin) {
    await db.query("insert into users (email, name, role) values ($1,$2,'admin') on conflict (email) do nothing",
      [admin, process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "Administrateur"]);
    console.log("Administrateur initial présent.");
  } else {
    console.log("BOOTSTRAP_ADMIN_EMAIL non défini : aucun utilisateur créé.");
  }
  if (process.env.SEED_DEMO_USERS === "true") {
    for (const [email, name, role] of [["tech@demo.local", "Technicien démo", "technicien"], ["direction@demo.local", "Direction démo", "direction"], ["admin-suivi@demo.local", "Administratif démo", "administratif"]]) {
      await db.query("insert into users (email, name, role) values ($1,$2,$3) on conflict (email) do nothing", [email, name, role]);
    }
    console.log("Utilisateurs de démonstration créés (développement uniquement).");
  }
  console.log("Véhicules de référence présents :", VEHICLES.length);
  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
