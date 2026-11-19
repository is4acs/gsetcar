import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { q } from "@/lib/db";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/permissions";
import { Badge, Field, Flash, Shell } from "@/components/ui";
import { alertContact } from "@/lib/queries";
import { secretMeta } from "@/lib/secrets";
import { VEHICLE_STATUS_LABELS } from "@/lib/labels";
import { fmtDate } from "@/lib/format";
import { DRIVE_SECRET, driveMode, folderUrl } from "@/lib/drive";
import { addVehicle, disconnectDrive, saveAlertContact, saveUser, setUserActive, setUserScope, setVehicleFolder, verifyFolderAction } from "@/app/actions";

export default async function Admin({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requirePermission("admin.manage");
  const [users, vehicles, scopes, contact, driveAccount] = await Promise.all([
    q<{ id: string; email: string; name: string; role: Role; active: boolean }>("select id, email, name, role, active from users order by active desc, role, name"),
    q<{ id: string; plate: string; label: string; status: string; drive_folder_id: string | null; drive_folder_name: string | null; drive_folder_verified_at: Date | null }>("select id, plate, label, status, drive_folder_id, drive_folder_name, drive_folder_verified_at from vehicles order by status, plate"),
    q<{ user_id: string; vehicle_id: string }>("select user_id, vehicle_id from user_vehicle_scope"),
    alertContact(),
    secretMeta<{ email: string | null }>(DRIVE_SECRET),
  ]);
  let mode: string;
  try { mode = driveMode(); } catch { mode = "none"; }
  const backInput = <input type="hidden" name="_back" value="/admin" />;
  return (
    <Shell user={user} title="Administration" wide>
      <Flash params={await searchParams} />
      <section className="card space-y-3">
        <h2 className="h2">Utilisateurs autorisés</h2>
        <p className="muted">Seules les adresses Google listées ici et actives peuvent se connecter. Les rôles sont à confirmer par la direction.</p>
        <div className="overflow-x-auto"><table className="table"><thead><tr><th>Nom</th><th>Adresse Google</th><th>Rôle</th><th>Périmètre véhicules</th><th /></tr></thead><tbody>
          {users.map((u) => { const mine = scopes.filter((s) => s.user_id === u.id).map((s) => s.vehicle_id); return (
            <tr key={u.id} className={u.active ? "" : "opacity-50"}>
              <td>{u.name}</td><td>{u.email}</td><td>{ROLE_LABELS[u.role]}{!u.active && <> <Badge>Désactivé</Badge></>}</td>
              <td>{u.role !== "technicien" ? "Tout le parc" : (
                <details><summary className="cursor-pointer text-blue-700">{mine.length ? `${mine.length} véhicule(s)` : "Tout le parc"}</summary>
                  <form action={setUserScope} className="mt-1 space-y-1">{backInput}<input type="hidden" name="id" value={u.id} />
                    {vehicles.filter((v) => v.status !== "vendu").map((v) => <label key={v.id} className="flex items-center gap-2"><input type="checkbox" name="vehicleIds" value={v.id} defaultChecked={mine.includes(v.id)} /> {v.plate}</label>)}
                    <p className="muted">Aucune case cochée = tout le parc.</p><button className="btn-secondary btn-sm">Enregistrer</button></form></details>)}</td>
              <td>{u.id !== user.id && <form action={setUserActive}>{backInput}<input type="hidden" name="id" value={u.id} /><input type="hidden" name="active" value={String(!u.active)} /><button className="btn-secondary btn-sm">{u.active ? "Désactiver" : "Réactiver"}</button></form>}</td>
            </tr>); })}
        </tbody></table></div>
        <form action={saveUser} className="grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-4">{backInput}
          <input name="name" required className="input" placeholder="Nom" /><input name="email" type="email" required className="input" placeholder="Adresse Google" />
          <select name="role" className="input">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
          <button className="btn-primary">Ajouter ou mettre à jour</button></form>
      </section>

      <section className="card space-y-3">
        <h2 className="h2">Véhicules et dossiers Drive</h2>
        <p className="muted">Chaque véhicule est lié à un identifiant de dossier stable. Aucun dépôt n&apos;a lieu tant que le dossier n&apos;a pas été vérifié avec les accès de l&apos;application. L&apos;application ne déplace, ne renomme et ne supprime jamais un document existant.</p>
        <div className="overflow-x-auto"><table className="table"><thead><tr><th>Véhicule</th><th>Statut</th><th>Dossier Drive</th><th>Dépôt pilote</th><th>Associer / vérifier</th></tr></thead><tbody>
          {vehicles.map((v) => (
            <tr key={v.id}>
              <td><Link href={`/vehicules/${v.id}`} className="font-mono font-semibold text-blue-700 underline">{v.plate}</Link><div className="muted">{v.label}</div></td>
              <td><Badge tone={v.status === "actif" ? "green" : v.status === "vendu" ? "gray" : "amber"}>{VEHICLE_STATUS_LABELS[v.status]}</Badge></td>
              <td>{v.drive_folder_id ? <a href={folderUrl(v.drive_folder_id)} target="_blank" rel="noreferrer" className="break-all text-blue-700 underline">{v.drive_folder_name ?? v.drive_folder_id}</a> : <Badge tone="red">À localiser</Badge>}</td>
              <td>{v.drive_folder_verified_at ? <Badge tone="green">Vérifié le {fmtDate(v.drive_folder_verified_at)}</Badge> : <Badge tone="amber">Non vérifié</Badge>}</td>
              <td><div className="flex flex-wrap gap-2">
                <form action={setVehicleFolder} className="flex gap-1">{backInput}<input type="hidden" name="id" value={v.id} /><input name="folder" required className="input min-h-9 w-44 text-sm" placeholder="ID ou lien du dossier" /><button className="btn-secondary btn-sm">Associer</button></form>
                {v.drive_folder_id && <form action={verifyFolderAction}>{backInput}<input type="hidden" name="id" value={v.id} /><button className="btn-secondary btn-sm">Vérifier</button></form>}
              </div></td>
            </tr>
          ))}
        </tbody></table></div>
        <form action={addVehicle} className="grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-4">{backInput}
          <input name="plate" required className="input" placeholder="Immatriculation" /><input name="label" required className="input" placeholder="Modèle" />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="nacelle" className="h-5 w-5" /> Nacelle</label><button className="btn-secondary">Ajouter (statut « à confirmer »)</button></form>
        <Link href="/admin/qr" className="text-sm text-blue-700 underline">Imprimer les QR codes des véhicules</Link>
      </section>

      <section className="card space-y-3">
        <h2 className="h2">Compte Google Drive</h2>
        <p className="muted">Le dossier « VEHICULES GUYANE » est dans « Mon Drive » : l&apos;application dépose les fichiers au nom d&apos;un compte Google GSET qui a le droit d&apos;écrire dans ces dossiers.</p>
        {mode === "mock" && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Simulateur Drive actif (développement) : aucun fichier n&apos;est envoyé vers Google Drive.</p>}
        {mode === "none" && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Drive non configuré (variable DRIVE_MODE) : les documents restent en attente.</p>}
        {mode === "service_account" && <p className="text-sm">Mode identité de service.</p>}
        {mode === "oauth" && (driveAccount
          ? <div className="flex flex-wrap items-center gap-3 text-sm"><Badge tone="green">Connecté</Badge><span>{driveAccount.email ?? "compte inconnu"} · depuis le {fmtDate(driveAccount.updated_at)}</span>
              <a href="/api/drive/oauth/start" className="btn-secondary btn-sm">Changer de compte</a>
              <form action={disconnectDrive}>{backInput}<button className="btn-secondary btn-sm">Déconnecter</button></form></div>
          : <div className="flex flex-wrap items-center gap-3 text-sm"><Badge tone="red">Aucun compte connecté</Badge><a href="/api/drive/oauth/start" className="btn-primary btn-sm">Connecter le compte Google GSET</a></div>)}
        <p className="muted">Après connexion, « Vérifier » sur chaque véhicule effectue un dépôt pilote : un petit fichier témoin est créé dans le dossier puis retiré. Aucun rapport n&apos;est déposé dans un dossier non vérifié.</p>
      </section>

      <section className="card space-y-3">
        <h2 className="h2">Appel en cas d&apos;immobilisation</h2>
        <form action={saveAlertContact} className="flex flex-wrap items-end gap-2">{backInput}
          <Field label="Personne à prévenir"><input name="name" className="input w-48" defaultValue={contact.name} /></Field>
          <Field label="Téléphone" hint="Utilisé par le bouton « Appeler » affiché au contrôleur."><input name="phone" type="tel" className="input w-56" defaultValue={contact.phone ?? ""} placeholder="+594 …" /></Field>
          <button className="btn-secondary">Enregistrer</button></form>
        {!contact.phone && <p className="text-sm font-medium text-amber-800">Numéro non renseigné : le contrôleur verra la consigne d&apos;appeler, sans bouton d&apos;appel direct.</p>}
      </section>
    </Shell>
  );
}
