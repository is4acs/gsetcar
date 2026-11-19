// Règles d'autorisation (pures, testées). Toujours appliquées côté serveur.
export type Role = "technicien" | "administratif" | "direction" | "admin";
export const ROLES: Role[] = ["technicien", "administratif", "direction", "admin"];
export const ROLE_LABELS: Record<Role, string> = {
  technicien: "Technicien",
  administratif: "Suivi administratif",
  direction: "Direction (validation budget)",
  admin: "Administrateur",
};

export type Permission =
  | "inspection.create"      // saisir un contrôle
  | "inspection.correct"     // corriger un contrôle (tracé, versionné)
  | "repair.edit"            // renseigner une réparation, déposer devis / facture
  | "repair.validate"        // valider ou refuser une dépense
  | "repair.edit_validated_estimate" // modifier un montant estimé déjà validé
  | "immobilization.propose"
  | "immobilization.decide"  // immobiliser / remettre en service
  | "issue.close"
  | "dashboard.view"         // tableau de bord direction, budgets, exports
  | "vehicle.edit"           // affectation, site, échéances
  | "vehicle.status"         // actif / vendu / à confirmer
  | "jobs.manage"            // voir et relancer les envois Drive
  | "admin.manage";          // utilisateurs, dossiers Drive, réglages

const MATRIX: Record<Permission, Role[]> = {
  "inspection.create": ["technicien", "direction", "admin"],
  "inspection.correct": ["technicien", "direction", "admin"],
  "repair.edit": ["technicien", "administratif", "direction", "admin"],
  "repair.validate": ["direction", "admin"],
  "repair.edit_validated_estimate": ["direction", "admin"],
  "immobilization.propose": ["technicien", "administratif", "direction", "admin"],
  "immobilization.decide": ["direction", "admin"],
  "issue.close": ["direction", "admin"],
  "dashboard.view": ["administratif", "direction", "admin"],
  "vehicle.edit": ["administratif", "direction", "admin"],
  "vehicle.status": ["direction", "admin"],
  "jobs.manage": ["administratif", "direction", "admin"],
  "admin.manage": ["admin"],
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[permission].includes(role);
}
