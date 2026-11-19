# Consignes pour Claude dans Chrome — mise en ligne de « Parc auto GSET »

Tu agis dans le navigateur de l'utilisateur, avec ses comptes déjà connectés (Vercel, Supabase, Google Cloud, GitHub).
Objectif : faire aboutir le déploiement Vercel de l'application et la rendre utilisable pour un premier essai sur un véhicule pilote.

- Dépôt GitHub : `is4acs/gsetcar`, branche `claude/dazzling-cannon-cb6mac`
- Application : Next.js + PostgreSQL + Google Drive. Documentation : `README.md` et `.env.example` du dépôt.

## Règles à respecter

1. **Aucun secret dans la conversation.** Ne recopie jamais un mot de passe, une clé ou un jeton dans le chat. Copie-les directement d'un onglet à l'autre.
2. **Demande avant toute dépense** (passage à une offre payante Vercel ou Supabase) et avant toute suppression.
3. **Ne touche pas au contenu Google Drive** : ne déplace, ne renomme, ne supprime et ne partage publiquement aucun fichier ni dossier.
4. **Ne modifie pas le code.** Si une étape échoue, relève le message d'erreur exact et rapporte-le à l'utilisateur.
5. Avance étape par étape et annonce en une phrase ce que tu viens de faire. Arrête-toi quand une information manque (voir « À demander à l'utilisateur »).

## À demander à l'utilisateur avant de commencer

- L'adresse Google de l'administrateur confirmé (elle servira à créer son compte dans l'application).
- Le compte Google GSET qui a le droit d'écrire dans le dossier Drive « VEHICULES GUYANE ».
- Deux chaînes aléatoires d'au moins 48 caractères, qu'il saisira lui-même dans Vercel pour `AUTH_SECRET` et `CRON_SECRET` (par exemple générées par son gestionnaire de mots de passe).
- S'il accepte l'offre Vercel Pro (l'offre Hobby est réservée à l'usage personnel non commercial). Sans réponse, reste sur l'offre actuelle.

## Étape 1 — Lire l'erreur du déploiement

1. Ouvre https://vercel.com, projet lié au dépôt `gsetcar`, onglet **Deployments**.
2. Ouvre le déploiement le plus récent. S'il est en erreur, ouvre **Build Logs** et relève les 20 dernières lignes.
3. Si l'erreur parle de *cron* : vérifie que le déploiement porte bien sur le dernier commit de la branche (le fichier `vercel.json` y planifie désormais une seule exécution par jour). Sinon, clique **Redeploy** sur le dernier commit.
4. Dans **Settings → Git**, note la branche de production. Si elle ne correspond à aucune branche existante du dépôt, signale-le à l'utilisateur et demande-lui s'il veut y mettre `claude/dazzling-cannon-cb6mac`.
5. Rapporte à l'utilisateur la cause de l'échec avant de continuer.

## Étape 2 — Base de données (Supabase)

1. Sur https://supabase.com/dashboard, crée un projet (région proche de la Guyane, par exemple `us-east-1` ou `sa-east-1`). Laisse l'utilisateur choisir et conserver le mot de passe de la base.
2. Ouvre **SQL Editor**. Colle et exécute le contenu complet du fichier `migrations/001_init.sql` (à lire sur GitHub, vue « Raw »).
3. Exécute ensuite ce bloc (il marque la migration comme appliquée et crée les véhicules de référence) :

```sql
create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now());
insert into schema_migrations (name) values ('001_init.sql') on conflict do nothing;

insert into vehicles (plate, label, nacelle, status, drive_folder_id, drive_factures_folder_id, control_week) values
  ('FA-763-MJ', 'Citroën Jumper',            false, 'actif', '18bOgOVbezXAVyHNgv9FA_ScDmir5bknn', null, 1),
  ('DV-454-FA', 'Peugeot Partner',           false, 'actif', null, null, 1),
  ('CR-761-AW', 'Renault Master / nacelle',  true,  'actif', '13oExZMet2T6NmQD9TM2dZTmRvdeiu2l1', null, 2),
  ('DQ-720-HZ', 'Citroën C3',                false, 'actif', '1T8i3eLr_q-D0_k0ROQt_AvTWpw0fBW8t', null, 2),
  ('CD-736-LP', 'Renault Master / nacelle',  true,  'actif', '1hgqd2tepQRg-JfqJ-7pK_DMXvl10Fb36', '19cH2GuE2kunWrJm8cMh_fupe5kS3cQeF', 3),
  ('CH-153-KE', 'Mercedes Benz',             false, 'actif', '1SiALgH3E4qbg63MLePG_PLTWAEiJrfBG', null, 3),
  ('ER-011-NB', 'Citroën Jumpy',             false, 'actif', '1bdj51cU1tpg0tYS0s7MxmjG94p8ZkDPV', null, 4),
  ('EP-315-FC', 'Renault Master',            false, 'actif', '1B4XOWLXdv5W_8Wq6k2oB9ccKsGRolPWN', null, 4),
  ('FW-817-GY', 'Citroën Jumpy (vu dans Drive)', false, 'a_confirmer', '1FlGa6swBW9lL1VnY7wopgIdPd4pqdHzL', null, null),
  ('EP-602-EQ', 'Dacia (vue dans Drive)',        false, 'a_confirmer', '1AA9Dudk7LW9R1DJ1TyXrg2Wtyw_SaiId', null, null)
on conflict (plate) do nothing;
```

4. Crée le compte administrateur en remplaçant les deux valeurs par celles données par l'utilisateur (adresse en minuscules) :

```sql
insert into users (email, name, role) values ('ADRESSE_ADMIN', 'NOM_ADMIN', 'admin') on conflict (email) do nothing;
```

5. Vérifie : `select count(*) from vehicles;` doit renvoyer 10 et `select count(*) from users;` doit renvoyer 1.
6. Dans **Connect**, repère la chaîne de connexion **Transaction pooler** (port 6543). Tu la copieras dans Vercel à l'étape 4, sans l'afficher dans le chat.

## Étape 3 — Google Cloud (connexion des utilisateurs et Drive)

Connecté avec le compte Google GSET, sur https://console.cloud.google.com :

1. Crée un projet « Parc auto GSET » (ou utilise celui que l'utilisateur indique).
2. **APIs et services → Bibliothèque** : active **Google Drive API**.
3. **Écran de consentement OAuth** : type **Interne** si le compte appartient à un Google Workspace (sinon « Externe » en mode test, en ajoutant comme utilisateurs de test l'administrateur et le compte Drive ; préviens l'utilisateur que dans ce mode l'accès Drive expire au bout de 7 jours). Portées : `openid`, `email`, `profile`, `https://www.googleapis.com/auth/drive`.
4. **Identifiants → Créer des identifiants → ID client OAuth → Application Web**. URI de redirection autorisés, où `APP_URL` est l'adresse de production Vercel (par exemple `https://gsetcar.vercel.app`, sans barre finale) :
   - `APP_URL/api/auth/callback`
   - `APP_URL/api/drive/oauth/callback`
5. Garde l'onglet ouvert pour copier l'ID client et le secret dans Vercel.

## Étape 4 — Variables d'environnement Vercel

Projet Vercel → **Settings → Environment Variables**, environnement **Production** :

| Nom | Valeur |
|---|---|
| `DATABASE_URL` | chaîne « Transaction pooler » de Supabase, avec le mot de passe |
| `AUTH_SECRET` | saisie par l'utilisateur (48 caractères aléatoires) |
| `CRON_SECRET` | saisie par l'utilisateur (autre chaîne aléatoire) |
| `APP_URL` | adresse de production, sans barre finale |
| `GOOGLE_CLIENT_ID` | ID client OAuth de l'étape 3 |
| `GOOGLE_CLIENT_SECRET` | secret du client OAuth |
| `DRIVE_MODE` | `oauth` |
| `NEXT_PUBLIC_APP_TIMEZONE` | `America/Cayenne` |

Ne crée **pas** `AUTH_DEV_LOGIN`, `SEED_DEMO_USERS` ni `DRIVE_MODE=mock` : ils sont réservés au développement.

Puis **Deployments → Redeploy** sur le dernier commit, et attends l'état « Ready ».

## Étape 5 — Vérifications dans l'application

1. Ouvre `APP_URL`. La page de connexion doit s'afficher. Clique « Se connecter avec Google » avec le compte administrateur.
   - Si une erreur de base apparaît (certificat), ajoute dans Vercel la variable `DATABASE_SSL` = `no-verify`, redéploie et signale-le à l'utilisateur.
   - « Ce compte Google n'est pas autorisé » : l'adresse de l'étape 2.4 ne correspond pas au compte utilisé.
2. Menu **Administration → Compte Google Drive** : clique « Connecter le compte Google GSET » et choisis le compte qui a le droit d'écrire dans « VEHICULES GUYANE ». Accorde l'accès Drive.
3. Toujours dans Administration, sur la ligne **CD-736-LP** (véhicule pilote), clique **Vérifier**. Résultat attendu : « vérifié par un dépôt pilote réussi (fichier témoin retiré) ». En cas d'échec, relève le message exact et arrête-toi.
4. Ne vérifie pas les autres dossiers et ne crée pas d'autres utilisateurs sans l'accord de l'utilisateur.

## Compte rendu attendu

Termine par un résumé court :
- cause de l'échec initial du déploiement ;
- état de chaque étape : fait, bloqué (avec le message d'erreur exact) ou non tenté ;
- adresse de l'application ;
- ce qui reste à faire par l'utilisateur : numéro de téléphone de Salim (Administration → Appel en cas d'immobilisation), comptes de Salim, d'Oumayma et du technicien, dossier Drive de DV-454-FA, confirmation du statut des véhicules, essai réel sur téléphone avec CD-736-LP.

Ne déclare pas l'application « en service » : seul l'essai réel sur le véhicule pilote le dira.
