# Parc auto GSET

Application interne de suivi du parc automobile de GSET Caraïbes : contrôles véhicule sur téléphone,
suivi des réparations, tableau de bord direction, classement automatique des rapports, photos, devis
et factures dans les dossiers Google Drive existants.

Next.js (TypeScript) · PostgreSQL · Google Drive · déploiement Vercel. Aucune IA : zéro appel de modèle.

> **État au 19 novembre 2026.** Le code est testé localement (base PostgreSQL réelle, Drive **simulé**).
> Rien n'est déployé. La connexion Google, la connexion au vrai Drive et le déploiement Vercel
> **n'ont pas été vérifiés** : ils demandent des accès listés dans « Ce qu'il reste à fournir ».

## Ce que fait l'application

**Technicien (téléphone)**
- Accueil à deux boutons : « Contrôler un véhicule », « Mettre à jour une réparation ».
- Contrôle : plaque (ou QR code) → kilométrage → questionnaire par groupes → récapitulatif → validation.
  Réponses : Bon / À surveiller / Intervention nécessaire / Non vérifié / Non applicable.
- Anomalie : commentaire, priorité, délai, photos (compressées sur le téléphone, 4 max par point).
- Problème critique à déclarer explicitement (Oui/Non), proposition d'immobilisation.
- Brouillon conservé sur le téléphone ; trois états affichés séparément : brouillon local,
  contrôle enregistré, documents déposés sur Drive.

**Réparations** — À chiffrer → Devis reçu → À valider → Validé → Planifié → En cours → Terminé ;
Refusé / Annulé avec motif. Garage, montants HT et TTC séparés (vide = « non renseigné », différent de 0 €),
dates, devis et factures. Une « Intervention nécessaire » ouvre automatiquement une réparation liée.
Terminer une réparation ne clôt que l'anomalie liée.

**Direction** — disponibles / immobilisés, contrôles dus, urgences, réparations ouvertes, devis à valider,
documents en attente ; filtres plaque / site / priorité / statut ; fiche véhicule ; exports CSV.

## Rôles (à confirmer par la direction)

| Action | Technicien | Suivi administratif | Direction | Administrateur |
|---|---|---|---|---|
| Saisir / corriger un contrôle | oui (corrige les siens) | non | oui | oui |
| Renseigner une réparation, déposer devis/facture | oui | oui | oui | oui |
| **Valider ou refuser une dépense** | **non** | **non** | oui | oui |
| Modifier un montant estimé soumis ou validé | non | non | oui | oui |
| Proposer une immobilisation | oui | oui | oui | oui |
| Immobiliser / remettre en service | non | non | oui | oui |
| Tableau de bord, budgets, exports | non | oui | oui | oui |
| Échéances, site, affectation | non | oui | oui | oui |
| Statut actif / vendu | non | non | oui | oui |
| Utilisateurs, dossiers Drive, réglages | non | non | non | oui |

Règles dans `src/lib/permissions.ts` et `src/lib/repair-status.ts`, appliquées côté serveur à chaque requête.
Seules les adresses Google listées et actives dans Administration peuvent se connecter (pas de filtre par domaine).
Un technicien peut être limité à certains véhicules (Administration → périmètre).

## Envoi vers Drive : fiable et sans doublon

1. La validation enregistre, **dans une seule transaction**, le contrôle, les anomalies, les réparations,
   les documents et un travail d'envoi par document (`drive_jobs`).
2. Une tâche planifiée Vercel (`vercel.json`, toutes les 2 minutes) appelle `/api/jobs/run`. Un déclenchement
   immédiat après validation accélère le dépôt, mais la garantie repose sur la file en base.
3. Pour chaque document : génération du PDF (pdf-lib), **réservation d'un identifiant Drive enregistré avant
   l'envoi**, puis création du fichier avec cet identifiant. Si Drive a accepté le fichier mais que la réponse
   s'est perdue, la reprise retrouve le fichier par son identifiant au lieu d'en créer un second.
4. Les photos et pièces en attente sont stockées en base (table privée `document_blobs`) et supprimées
   **uniquement après confirmation** du dépôt. Drive reste le seul dépôt permanent.
5. Erreur passagère : nouvelles tentatives à 1, 2, 4, 8 min… (plafond 6 h, 8 essais) puis « Échec ».
   Problème d'accès ou de configuration : « Bloqué », revérifié toutes les 15 min. Tout est visible et
   relançable à la main dans « Envois Drive ».
6. Aucun dépôt tant que le dossier du véhicule n'a pas été **vérifié avec les accès de l'application**
   (Administration → Vérifier). L'application ne déplace, ne renomme et ne supprime jamais un fichier existant.

Classement : rapports et photos dans le sous-dossier `Contrôles` (créé s'il manque, verrou contre les
créations concurrentes) ; factures dans `Factures` (dossier existant réutilisé) ; devis à la racine du dossier
véhicule. Noms : `2026-11-19_CD-736-LP_Controle_<id>.pdf`, corrections en `_v2`, `_v3` sans écrasement.

## Limites connues

- **Hors connexion** : un contrôle ouvert peut être rempli sans réseau et le brouillon survit à la fermeture
  de la page ; mais ouvrir une nouvelle page et valider demandent du réseau (pas de mode hors ligne complet).
  Le brouillon vit dans le navigateur du téléphone : il est perdu si les données du site sont effacées ou en navigation privée.
- **Photos** : JPEG, réduites à 1600 px, 3 Mo max après compression. **Devis/factures** : PDF, JPEG, PNG, 4 Mo max.
- **Questionnaire** : version provisoire (`src/lib/checklist.ts`) bâtie sur les groupes du cadrage, à rapprocher
  de la « Fiche de contrôle » du classeur. Les **points spécifiques nacelle sont absents** (fiche métier à valider) :
  l'écran et le rapport le signalent.
- **Correction d'un contrôle** : kilométrage et commentaire général (tracé, versionné). Les réponses ne se
  modifient pas : refaire un contrôle.
- **Périodicité des contrôles** : non définie par défaut ; tant qu'elle ne l'est pas, seul « jamais contrôlé » est signalé.
- Le formulaire ne remplace pas les contrôles réglementaires et ne déclare jamais un véhicule « apte ».
- Aucune donnée du classeur n'est importée (ni les lignes d'exemple, ni les budgets préremplis) : seuls les
  dix véhicules du cadrage sont créés, avec un statut à confirmer.

## Installation

```bash
npm install
cp .env.example .env.local   # puis compléter
npm run migrate              # crée les tables
npm run seed                 # véhicules de référence + premier administrateur
npm run dev
```

Développement sans Google : `AUTH_DEV_LOGIN=true`, `SEED_DEMO_USERS=true`, `DRIVE_MODE=mock`
(simulateur écrivant dans `.drive-mock/`, refusé en production).

Tests : `npm test` (règles métier) ; avec `TEST_DATABASE_URL=postgres://…` pointant sur une base **vide dédiée**
(elle est réinitialisée), les tests d'intégration vérifient double soumission, panne Drive, réponse perdue,
dossier non vérifié, correction versionnée et périmètres.

## Mise en production (non réalisée)

1. **Base** : projet PostgreSQL (Supabase par exemple), `DATABASE_URL`, puis `npm run migrate` et `npm run seed`
   avec `BOOTSTRAP_ADMIN_EMAIL`.
2. **Connexion Google** : client OAuth « Application Web » dans Google Cloud, URI de redirection
   `<APP_URL>/api/auth/callback`.
3. **Drive** — choisir selon le type réel de Drive :
   - *Drive partagé* : `DRIVE_MODE=service_account`, identité de service ajoutée comme « Gestionnaire de contenu ».
   - *Mon Drive d'un utilisateur* : une identité de service n'y a pas de quota de stockage propre et ne peut
     en général pas y créer de fichiers → `DRIVE_MODE=oauth` avec le jeton d'un compte habilité (portée `drive`).
   - Activer l'API Google Drive. Ne jamais rendre les dossiers publics.
4. **Vercel** (offre Pro : usage commercial et tâche planifiée toutes les 2 minutes) : variables de `.env.example`,
   dont `CRON_SECRET` et `APP_URL`.
5. Administration : créer les utilisateurs, **vérifier chaque dossier Drive**, renseigner celui de DV-454-FA,
   définir la périodicité. Direction : confirmer le statut de chaque véhicule.
6. **Pilote sur un véhicule** avant généralisation : une soumission réelle, une photo, une facture,
   une correction et une reprise après erreur.

## Structure

- `migrations/` schéma SQL · `scripts/` migration et données de référence
- `src/lib/` règles métier, Drive, PDF, file d'envoi · `src/app/` écrans et API · `tests/`

Tables : `users`, `user_vehicle_scope`, `vehicles`, `settings`, `inspections`, `inspection_answers`, `issues`,
`repairs`, `immobilizations`, `vehicle_deadlines`, `documents`, `document_blobs`, `staged_uploads`,
`drive_jobs`, `audit_log`.
