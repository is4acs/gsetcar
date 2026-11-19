# Parc auto GSET

Application interne de suivi du parc automobile de GSET Caraïbes : contrôles véhicule sur téléphone,
suivi des réparations, tableau de bord direction, classement automatique des rapports, photos, devis
et factures dans les dossiers Google Drive existants.

Next.js (TypeScript) · PostgreSQL · Google Drive · déploiement Vercel. Aucune IA : zéro appel de modèle.

> **État au 19 novembre 2026.** Le code est testé localement (base PostgreSQL réelle, Drive **simulé**).
> Rien n'est déployé. La connexion Google, la connexion au vrai Drive et le déploiement Vercel
> **n'ont pas été vérifiés** : ils demandent des accès listés dans « Ce qu'il reste à fournir ».

## Ce que fait l'application

**Contrôleur (téléphone)**
- Accueil à deux boutons : « Contrôler un véhicule », « Mettre à jour une réparation ».
- Les véhicules à contrôler cette semaine (planning S1 à S4) sont proposés en premier.
- Questionnaire = onglet « Fiche de contrôle » du classeur : 50 points, 10 rubriques, mêmes numéros.
  États : OK / À surveiller / À réparer / Urgent / N/A, plus « Non vérifié » (à justifier).
- Mesure / valeur (pneus, batterie, extincteur…), photos des défauts (compressées sur le téléphone, 4 par point).
- « À réparer » ou « Urgent » : constat obligatoire et recommandation (délai, réparation, coût estimé HT, garage)
  reprise telle quelle dans la réparation créée — aucune ressaisie par le suivi administratif.
- Signatures au doigt du contrôleur et du conducteur (ou motif si le conducteur ne signe pas), intégrées au PDF.
- Brouillon conservé sur le téléphone ; trois états affichés séparément : brouillon local,
  contrôle enregistré, documents déposés sur Drive.

**Immobilisation (règle du classeur)** — un point « Urgent » sur les freins, les pneus, la direction ou
l'éclairage déclare le véhicule « Immobilisé » dès la validation du contrôle, et affiche le bouton
« Appeler Salim » (numéro saisi dans Administration). Un « Urgent » sur un autre point alerte la direction
sans immobiliser ; le contrôleur peut alors proposer l'immobilisation. La remise en circulation est tracée
(qui, quand, sur quelle base) ; par défaut elle est réservée aux rôles Direction et Administrateur,
**en attendant que la personne habilitée soit confirmée**.

**Planning et registre** — un contrôle par véhicule et par mois, deux véhicules par semaine (S1 à S4, repris
du classeur, modifiable sur la fiche véhicule). La page « Planning » reproduit les onglets « Planning »
(Fait / À faire / En retard, taux de réalisation) et « Registre contrôles », calculés automatiquement.

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
| Échéances, site, conducteur, semaine de contrôle | non | oui | oui | oui |
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
6. Aucun dépôt tant que le dossier du véhicule n'a pas été **vérifié par un dépôt pilote avec le compte connecté**
   (Administration → Vérifier). L'application ne déplace, ne renomme et ne supprime jamais un fichier existant.

Classement : rapports et photos dans le sous-dossier `Contrôles` (créé s'il manque, verrou contre les
créations concurrentes) ; factures dans `Factures` (dossier existant réutilisé) ; devis à la racine du dossier
véhicule. Noms : `2026-11-19_CD-736-LP_Controle_<id>.pdf`, corrections en `_v2`, `_v3` sans écrasement.

## Écarts assumés par rapport au classeur

- Le classeur propose un résultat « Apte / Apte avec réserves ». L'application n'écrit jamais « Apte » : elle
  affiche une synthèse factuelle (Immobilisé, point urgent, réparations à prévoir, fiche incomplète, points à
  surveiller, aucune anomalie constatée sur les points vérifiés).
- Le classeur classe les fichiers par type (« 06 PARC AUTO / 1-Contrôles mensuels / … »). L'application suit
  l'organisation réelle du Drive : un dossier par immatriculation dans « VEHICULES GUYANE ».
- L'envoi de la fiche par e-mail est remplacé par le tableau de bord et le dépôt automatique.
- Le budget prévisionnel mensuel de l'onglet « Budget » n'est pas repris (montants préremplis, non confirmés).

## Limites connues

- **Hors connexion** : un contrôle ouvert peut être rempli sans réseau et le brouillon survit à la fermeture
  de la page ; mais ouvrir une nouvelle page et valider demandent du réseau (pas de mode hors ligne complet).
  Le brouillon vit dans le navigateur du téléphone : il est perdu si les données du site sont effacées ou en navigation privée.
- **Photos** : JPEG, réduites à 1600 px, 3 Mo max après compression. **Devis/factures** : PDF, JPEG, PNG, 4 Mo max.
- **Nacelle** : la fiche du classeur ne contient aucun point nacelle ; l'écran et le rapport le signalent.
- **Correction d'un contrôle** : kilométrage et commentaire général (tracé, versionné). Les réponses ne se
  modifient pas : refaire un contrôle.
- La fiche ne remplace pas les contrôles réglementaires.
- **Données du classeur** : seul l'onglet « Parc » est repris (`npm run import:parc`). Les lignes d'exemple du
  registre et du suivi des réparations sont écartées ; aucune ligne de ces onglets n'est importée.

## Installation

```bash
npm install
cp .env.example .env.local   # puis compléter
npm run migrate              # crée les tables
npm run seed                 # véhicules de référence (plaques, semaine S1–S4, dossiers Drive) + premier administrateur
npm run import:parc -- chemin/Suivi_Parc_Auto_GSET.xlsx          # simulation
npm run import:parc -- chemin/Suivi_Parc_Auto_GSET.xlsx --apply  # conducteurs, site, carte grise
npm run dev
```

Le classeur contient des données nominatives : il n'est pas versionné, et le premier administrateur est créé
à partir de `BOOTSTRAP_ADMIN_EMAIL` (à ne renseigner qu'une fois la personne confirmée).

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
3. **Drive** — le dossier « VEHICULES GUYANE » (`1rAF8Zuge154rJekKGx6VzrzheZfDnPiO`) est dans « Mon Drive » :
   `DRIVE_MODE=oauth`. Activer l'API Google Drive, ajouter l'URI `<APP_URL>/api/drive/oauth/callback` au client
   OAuth (portée `drive`, écran de consentement « Interne » si le compte est dans Google Workspace), puis dans
   Administration : « Connecter le compte Google GSET ». Le jeton est stocké chiffré en base. Ne jamais rendre
   les dossiers publics. (Un Drive partagé permettrait `DRIVE_MODE=service_account`.)
4. **Vercel** (offre Pro : usage commercial et tâche planifiée toutes les 2 minutes) : variables de `.env.example`,
   dont `CRON_SECRET` et `APP_URL`.
5. Administration : créer les utilisateurs, saisir le numéro d'appel en cas d'immobilisation, **vérifier chaque
   dossier Drive par un dépôt pilote** (fichier témoin créé puis retiré), associer celui de DV-454-FA quand il
   sera identifié (ses rapports restent en attente d'ici là). Direction : confirmer le statut de chaque véhicule.
6. **Pilote sur un véhicule** avant généralisation : une soumission réelle, une photo, une facture,
   une correction et une reprise après erreur.

## Structure

- `migrations/` schéma SQL · `scripts/` migration et données de référence
- `src/lib/` règles métier, Drive, PDF, file d'envoi · `src/app/` écrans et API · `tests/`

Tables : `users`, `user_vehicle_scope`, `vehicles`, `settings`, `inspections`, `inspection_answers`, `issues`,
`inspection_signatures`, `repairs`, `immobilizations`, `vehicle_deadlines`, `documents`, `document_blobs`, `staged_uploads`,
`drive_jobs`, `app_secrets`, `audit_log`.
