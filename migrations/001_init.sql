-- Schéma initial — suivi du parc automobile GSET Caraïbes

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  name text not null,
  role text not null check (role in ('technicien','administratif','direction','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  plate text not null unique,
  label text not null,
  nacelle boolean not null default false,
  -- 'a_confirmer' : présent dans Drive ou le classeur mais statut non validé par la direction
  status text not null check (status in ('actif','a_confirmer','vendu')),
  status_confirmed_at timestamptz,
  status_confirmed_by uuid references users(id),
  site text,
  assignment text, -- conducteur affecté
  notes text,
  cg_holder text,    -- titulaire de la carte grise (classeur)
  cg_status text,    -- statut de la carte grise (classeur)
  control_week integer check (control_week between 1 and 4), -- semaine du mois prévue pour le contrôle (S1 à S4)
  drive_folder_id text,
  drive_folder_name text,
  drive_folder_verified_at timestamptz,
  drive_controles_folder_id text,
  drive_factures_folder_id text,
  created_at timestamptz not null default now()
);

-- Périmètre optionnel : si un technicien a des lignes ici, il ne voit que ces véhicules.
create table user_vehicle_scope (
  user_id uuid not null references users(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  primary key (user_id, vehicle_id)
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id)
);

create table inspections (
  id uuid primary key, -- généré côté téléphone : clé d'idempotence de la soumission
  vehicle_id uuid not null references vehicles(id),
  author_id uuid not null references users(id),
  performed_at timestamptz not null,
  mileage_km integer not null check (mileage_km >= 0),
  previous_km integer,        -- dernier relevé connu au moment du contrôle
  location text,              -- lieu du contrôle
  driver_name text,           -- conducteur affecté au moment du contrôle
  checklist_version text not null,
  general_comment text,
  critical_flag boolean not null,
  critical_comment text,
  critical_ack_by uuid references users(id), -- prise en compte par la direction
  critical_ack_at timestamptz,
  summary text not null,
  version integer not null default 1,
  created_at timestamptz not null default now()
);
create index on inspections (vehicle_id, performed_at desc);

create table inspection_answers (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections(id) on delete cascade,
  position integer not null,
  ref integer not null,       -- numéro du point sur la fiche de contrôle
  item_code text not null,
  group_label text not null,
  item_label text not null,
  essential boolean not null,
  answer text not null check (answer in ('bon','a_surveiller','intervention','urgent','non_verifie','non_applicable')),
  measure text,               -- mesure / valeur relevée
  comment text,
  -- Recommandation de réparation (points « À réparer » ou « Urgent »)
  priority text check (priority in ('urgent','15_jours','1_mois','prochain_entretien')),
  recommendation text,
  estimate_ht_cents integer check (estimate_ht_cents >= 0),
  garage text,
  unique (inspection_id, item_code)
);

create table issues (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id),
  inspection_id uuid references inspections(id),
  answer_id uuid references inspection_answers(id),
  title text not null,
  description text,
  severity text not null check (severity in ('a_surveiller','intervention','urgent')),
  priority text check (priority in ('urgent','15_jours','1_mois','prochain_entretien')), -- NULL pour un point à surveiller
  status text not null default 'ouverte' check (status in ('ouverte','resolue','classee')),
  closed_at timestamptz,
  closed_by uuid references users(id),
  close_reason text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);
create index on issues (vehicle_id, status);

create table repairs (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id),
  issue_id uuid references issues(id),
  title text not null,
  description text,
  status text not null default 'a_chiffrer' check (status in
    ('a_chiffrer','devis_recu','a_valider','valide','planifie','en_cours','termine','refuse','annule')),
  urgent boolean not null default false,
  garage text,
  -- Montants en centimes. NULL = non renseigné (différent de 0).
  estimate_ht_cents integer check (estimate_ht_cents >= 0),
  estimate_ttc_cents integer check (estimate_ttc_cents >= 0),
  actual_ht_cents integer check (actual_ht_cents >= 0),
  actual_ttc_cents integer check (actual_ttc_cents >= 0),
  quote_received_on date,
  planned_on date,
  started_on date,
  completed_on date,
  validated_by uuid references users(id),
  validated_at timestamptz,
  status_reason text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on repairs (vehicle_id, status);
-- Une seule réparation non close par anomalie (évite les doublons de double clic).
create unique index repairs_one_open_per_issue on repairs (issue_id)
  where issue_id is not null and status not in ('termine','refuse','annule');

create table immobilizations (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id),
  inspection_id uuid references inspections(id),
  repair_id uuid references repairs(id),
  reason text not null,
  -- true : déclarée automatiquement par la règle de sécurité (freins, pneus, direction, éclairage) à la validation du contrôle
  auto_rule boolean not null default false,
  status text not null default 'proposee' check (status in ('proposee','active','rejetee','levee')),
  proposed_by uuid not null references users(id),
  proposed_at timestamptz not null default now(),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text,
  released_by uuid references users(id),
  released_at timestamptz,
  release_note text
);
create index on immobilizations (vehicle_id, status);
create unique index immobilizations_one_per_inspection on immobilizations (inspection_id)
  where inspection_id is not null;

-- Signatures tracées sur le téléphone (contrôleur, conducteur), intégrées au rapport PDF.
create table inspection_signatures (
  inspection_id uuid not null references inspections(id) on delete cascade,
  role text not null check (role in ('controleur','conducteur')),
  signer_name text not null,
  image bytea not null, -- PNG
  signed_at timestamptz not null default now(),
  primary key (inspection_id, role)
);
alter table inspections add column driver_absent_reason text; -- renseigné si le conducteur n'a pas pu signer

create table vehicle_deadlines (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id),
  kind text not null check (kind in ('ct','assurance','entretien','autre')),
  due_on date not null,
  source text not null check (length(trim(source)) > 0), -- provenance obligatoire
  note text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  superseded_at timestamptz
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('rapport_controle','photo','devis','facture')),
  vehicle_id uuid not null references vehicles(id),
  inspection_id uuid references inspections(id),
  item_code text,
  repair_id uuid references repairs(id),
  version integer not null default 1,
  filename text not null,
  mime text not null,
  size_bytes integer,
  target text not null check (target in ('racine','controles','factures')),
  sync_status text not null default 'en_attente' check (sync_status in ('en_attente','depose')),
  drive_file_id text,      -- réservé avant l'envoi, confirmé par synced_at
  drive_web_link text,
  synced_at timestamptz,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);
create unique index documents_one_report_per_version on documents (inspection_id, version)
  where kind = 'rapport_controle';
create index on documents (vehicle_id);
create index on documents (repair_id);

-- Stockage temporaire privé des fichiers en attente de dépôt Drive.
-- La ligne est supprimée uniquement après confirmation du transfert.
create table document_blobs (
  document_id uuid primary key references documents(id) on delete cascade,
  data bytea not null,
  created_at timestamptz not null default now()
);

-- Photos envoyées par le téléphone avant la validation du contrôle.
create table staged_uploads (
  id uuid primary key, -- généré côté téléphone
  uploader_id uuid not null references users(id),
  mime text not null,
  size_bytes integer not null,
  data bytea not null,
  created_at timestamptz not null default now()
);

create table drive_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null unique references documents(id) on delete cascade,
  status text not null default 'en_attente' check (status in ('en_attente','en_cours','termine','echec','bloque')),
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index on drive_jobs (status, next_attempt_at);

-- Secrets applicatifs chiffrés (AES-256-GCM, clé dérivée de AUTH_SECRET) : jeton Drive du compte connecté.
create table app_secrets (
  key text primary key,
  ciphertext text not null,
  meta jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id)
);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid references users(id),
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb
);
create index on audit_log (entity, entity_id);
