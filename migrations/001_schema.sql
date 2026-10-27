-- Institutional Proximity — core schema.
-- All factual records hang off a claim; the claim carries the verification lifecycle.

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS public_api;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
CREATE TYPE core.claim_status AS ENUM (
  'draft', 'researching', 'pending_review', 'verified', 'published',
  'needs_reverification', 'disputed', 'retracted'
);

CREATE TYPE core.claim_category AS ENUM (
  'verified_fact', 'official_finding', 'reported_allegation',
  'analytical_interpretation', 'unknown'
);

-- What kind of record a claim backs. Facet claims (mandate, legal_basis …) are
-- displayed as text on a profile; record claims back a structured row.
CREATE TYPE core.claim_kind AS ENUM (
  'identity', 'mandate', 'legal_basis', 'funding', 'accountability', 'composition',
  'position', 'relationship', 'appointment_process', 'appointment_stage',
  'safeguard', 'legal_event', 'other'
);

CREATE TYPE core.date_precision AS ENUM ('day', 'month', 'year', 'unknown');

CREATE TYPE core.entity_kind AS ENUM (
  'independent_institution', 'government_body', 'selection_body', 'legislature', 'court'
);

CREATE TYPE core.legal_category AS ENUM (
  'constitutional_body', 'statutory_body', 'executive_body', 'constitutional_office',
  'parliamentary_body', 'judicial_body', 'other'
);

CREATE TYPE core.relationship_type AS ENUM (
  'appointed_by', 'nominated_by', 'selected_through', 'previously_held_position_at',
  'served_as_member_of', 'formally_reports_to', 'has_statutory_responsibility_for',
  'has_jurisdiction_over', 'participates_in_appointment_of', 'subsequently_appointed_to'
);

CREATE TYPE core.appointment_type AS ENUM (
  'appointed', 'nominated', 'elected', 'ex_officio', 'additional_charge', 'acting', 'unknown'
);

CREATE TYPE core.safeguard_dimension AS ENUM (
  'appointment', 'tenure', 'removal', 'conditions_of_service', 'financial',
  'operational_autonomy', 'transparency', 'accountability'
);

CREATE TYPE core.legal_event_type AS ENUM (
  'constitutional_provision', 'constitutional_amendment', 'bill_introduced', 'bill_passed',
  'act_enacted', 'act_commenced', 'amendment_enacted', 'rules_notified', 'notification',
  'judgment', 'interim_order', 'appeal_filed', 'stay', 'review', 'other'
);

CREATE TYPE core.event_relation AS ENUM (
  'appeal_of', 'stay_of', 'review_of', 'amends', 'supersedes', 'implements', 'responds_to'
);

CREATE TYPE core.source_type AS ENUM (
  -- Tier 1: primary authoritative
  'constitution', 'legislation', 'gazette_notification', 'judgment', 'official_website',
  'appointment_notification', 'parliamentary_record', 'committee_report',
  'government_publication', 'institutional_report',
  -- Tier 2: reputable secondary
  'news_report', 'peer_reviewed', 'academic', 'legal_research', 'civil_society',
  -- Tier 3: discovery only
  'discovery_other'
);

CREATE TYPE core.source_availability AS ENUM ('available', 'unavailable', 'changed_since_access', 'unknown');

CREATE TYPE core.evidence_role AS ENUM ('supports', 'contradicts', 'context');

CREATE TYPE core.user_role AS ENUM ('researcher', 'reviewer', 'publisher', 'admin');

CREATE TYPE core.correction_status AS ENUM (
  'received', 'under_review', 'referred_legal', 'resolved_corrected', 'resolved_no_change', 'rejected'
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- A (date, precision) pair is valid only if it never claims more precision than it has.
CREATE FUNCTION core.valid_dated(d date, p core.date_precision) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p
    WHEN 'unknown' THEN d IS NULL
    WHEN 'year'    THEN d IS NOT NULL AND extract(month FROM d) = 1 AND extract(day FROM d) = 1
    WHEN 'month'   THEN d IS NOT NULL AND extract(day FROM d) = 1
    WHEN 'day'     THEN d IS NOT NULL
  END
$$;

CREATE FUNCTION core.valid_url(u text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT u IS NULL OR (u ~ '^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[^\s<>"]*)?$' AND length(u) <= 2000)
$$;

CREATE FUNCTION core.source_tier(t core.source_type) RETURNS smallint
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN t IN ('constitution','legislation','gazette_notification','judgment','official_website',
               'appointment_notification','parliamentary_record','committee_report',
               'government_publication','institutional_report') THEN 1
    WHEN t IN ('news_report','peer_reviewed','academic','legal_research','civil_society') THEN 2
    ELSE 3
  END::smallint
$$;

-- ---------------------------------------------------------------------------
-- Editorial users and sessions
-- ---------------------------------------------------------------------------
CREATE TABLE core.app_user (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_.-]{3,40}$'),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  -- Public-facing role label shown on published reviews (never a personal name by default).
  public_role_label text NOT NULL DEFAULT 'Editorial reviewer',
  roles         core.user_role[] NOT NULL DEFAULT '{researcher}',
  -- Automated/AI accounts are is_human = false and can never verify or publish.
  is_human      boolean NOT NULL DEFAULT true,
  password_hash text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (is_human OR password_hash IS NULL)
);

CREATE TABLE core.session (
  token_hash  text PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES core.app_user(id) ON DELETE CASCADE,
  csrf_token  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX session_expires_idx ON core.session (expires_at);

-- ---------------------------------------------------------------------------
-- Entities
-- ---------------------------------------------------------------------------
CREATE TABLE core.institution (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  canonical_name   text NOT NULL CHECK (length(canonical_name) BETWEEN 2 AND 200),
  short_name       text CHECK (length(short_name) <= 40),
  entity_kind      core.entity_kind NOT NULL,
  legal_category   core.legal_category NOT NULL,
  official_website text CHECK (core.valid_url(official_website)),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.person (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  canonical_name text NOT NULL CHECK (length(canonical_name) BETWEEN 2 AND 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------
CREATE TABLE core.claim (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id              text GENERATED ALWAYS AS ('C-' || lpad(id::text, 6, '0')) STORED UNIQUE,
  kind                   core.claim_kind NOT NULL,
  claim_text             text NOT NULL CHECK (length(claim_text) BETWEEN 10 AND 2000),
  claim_category         core.claim_category NOT NULL,
  subject_institution_id integer REFERENCES core.institution(id),
  subject_person_id      integer REFERENCES core.person(id),
  temporal_scope         text CHECK (length(temporal_scope) <= 300),
  is_sensitive           boolean NOT NULL DEFAULT false,
  known_limitations      text CHECK (length(known_limitations) <= 2000),   -- public
  review_notes           text CHECK (length(review_notes) <= 5000),        -- internal only
  public_correction_note text CHECK (length(public_correction_note) <= 2000), -- public, for withdrawals
  attention_reason       text CHECK (length(attention_reason) <= 500),     -- internal queue flag
  status                 core.claim_status NOT NULL DEFAULT 'draft',
  supersedes_claim_id    bigint REFERENCES core.claim(id),
  created_by             integer NOT NULL REFERENCES core.app_user(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  last_verified_at       timestamptz,
  published_at           timestamptz,
  retracted_at           timestamptz,
  CHECK (num_nonnulls(subject_institution_id, subject_person_id) = 1),
  CHECK (supersedes_claim_id IS NULL OR supersedes_claim_id <> id)
);
CREATE INDEX claim_status_idx ON core.claim (status);
CREATE INDEX claim_subject_inst_idx ON core.claim (subject_institution_id);
CREATE INDEX claim_subject_person_idx ON core.claim (subject_person_id);

-- ---------------------------------------------------------------------------
-- Structured records (each backed by exactly one claim)
-- ---------------------------------------------------------------------------
CREATE TABLE core.position (
  id                      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id                bigint NOT NULL UNIQUE REFERENCES core.claim(id),
  person_id               integer NOT NULL REFERENCES core.person(id),
  institution_id          integer NOT NULL REFERENCES core.institution(id),
  title                   text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  start_date              date,
  start_precision         core.date_precision NOT NULL DEFAULT 'unknown',
  end_date                date,
  end_precision           core.date_precision NOT NULL DEFAULT 'unknown',
  -- A date on which a source establishes the tenure was still ongoing. Never "current" by assumption.
  ongoing_as_of           date,
  appointment_type        core.appointment_type NOT NULL DEFAULT 'unknown',
  appointing_authority_id integer REFERENCES core.institution(id),
  CHECK (core.valid_dated(start_date, start_precision)),
  CHECK (core.valid_dated(end_date, end_precision)),
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  CHECK (ongoing_as_of IS NULL OR end_date IS NULL)
);
CREATE INDEX position_person_idx ON core.position (person_id);
CREATE INDEX position_inst_idx ON core.position (institution_id);

CREATE TABLE core.relationship (
  id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id              bigint NOT NULL UNIQUE REFERENCES core.claim(id),
  source_person_id      integer REFERENCES core.person(id),
  source_institution_id integer REFERENCES core.institution(id),
  target_person_id      integer REFERENCES core.person(id),
  target_institution_id integer REFERENCES core.institution(id),
  relationship_type     core.relationship_type NOT NULL,
  description           text NOT NULL CHECK (length(description) BETWEEN 10 AND 600),
  valid_from            date,
  valid_from_precision  core.date_precision NOT NULL DEFAULT 'unknown',
  valid_until           date,
  valid_until_precision core.date_precision NOT NULL DEFAULT 'unknown',
  CHECK (num_nonnulls(source_person_id, source_institution_id) = 1),
  CHECK (num_nonnulls(target_person_id, target_institution_id) = 1),
  CHECK (source_person_id IS DISTINCT FROM target_person_id OR source_person_id IS NULL),
  CHECK (source_institution_id IS DISTINCT FROM target_institution_id OR source_institution_id IS NULL),
  CHECK (core.valid_dated(valid_from, valid_from_precision)),
  CHECK (core.valid_dated(valid_until, valid_until_precision)),
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from)
);

CREATE TABLE core.appointment_process (
  id                     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id               bigint NOT NULL UNIQUE REFERENCES core.claim(id),
  institution_id         integer NOT NULL REFERENCES core.institution(id),
  office_title           text NOT NULL CHECK (length(office_title) BETWEEN 2 AND 200),
  legal_basis            text NOT NULL CHECK (length(legal_basis) BETWEEN 2 AND 400),
  process_description    text NOT NULL CHECK (length(process_description) BETWEEN 10 AND 2000),
  effective_from         date,
  effective_from_precision  core.date_precision NOT NULL DEFAULT 'unknown',
  effective_until        date,
  effective_until_precision core.date_precision NOT NULL DEFAULT 'unknown',
  CHECK (core.valid_dated(effective_from, effective_from_precision)),
  CHECK (core.valid_dated(effective_until, effective_until_precision))
);

CREATE TABLE core.appointment_stage (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id             bigint NOT NULL UNIQUE REFERENCES core.claim(id),
  process_id           integer NOT NULL REFERENCES core.appointment_process(id),
  seq                  smallint NOT NULL CHECK (seq BETWEEN 1 AND 50),
  stage_title          text NOT NULL CHECK (length(stage_title) BETWEEN 2 AND 160),
  actor_institution_id integer REFERENCES core.institution(id),
  actor_label          text NOT NULL CHECK (length(actor_label) BETWEEN 2 AND 300),
  role_description     text NOT NULL CHECK (length(role_description) BETWEEN 10 AND 1200),
  provision_label      text CHECK (length(provision_label) <= 160),
  UNIQUE (process_id, seq)
);

CREATE TABLE core.safeguard (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id           bigint NOT NULL UNIQUE REFERENCES core.claim(id),
  institution_id     integer NOT NULL REFERENCES core.institution(id),
  dimension          core.safeguard_dimension NOT NULL,
  provision_label    text NOT NULL CHECK (length(provision_label) BETWEEN 2 AND 160),
  establishes        text NOT NULL CHECK (length(establishes) BETWEEN 10 AND 1500),
  does_not_establish text NOT NULL CHECK (length(does_not_establish) BETWEEN 10 AND 1500),
  limitations        text CHECK (length(limitations) <= 1500)
);

CREATE TABLE core.legal_event (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id             bigint NOT NULL UNIQUE REFERENCES core.claim(id),
  institution_id       integer REFERENCES core.institution(id),
  event_type           core.legal_event_type NOT NULL,
  title                text NOT NULL CHECK (length(title) BETWEEN 2 AND 300),
  event_date           date,
  event_precision      core.date_precision NOT NULL DEFAULT 'unknown',
  procedural_status    text CHECK (length(procedural_status) <= 600),
  related_event_id     integer REFERENCES core.legal_event(id),
  relation_to_related  core.event_relation,
  CHECK (core.valid_dated(event_date, event_precision)),
  CHECK ((related_event_id IS NULL) = (relation_to_related IS NULL)),
  CHECK (related_event_id IS DISTINCT FROM id)
);

-- ---------------------------------------------------------------------------
-- Sources and evidence links
-- ---------------------------------------------------------------------------
CREATE TABLE core.source (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id           text GENERATED ALWAYS AS ('S-' || lpad(id::text, 5, '0')) STORED UNIQUE,
  title               text NOT NULL CHECK (length(title) BETWEEN 2 AND 400),
  publisher           text NOT NULL CHECK (length(publisher) BETWEEN 2 AND 200),
  canonical_url       text NOT NULL CHECK (core.valid_url(canonical_url)),
  source_type         core.source_type NOT NULL,
  tier                smallint GENERATED ALWAYS AS (core.source_tier(source_type)) STORED,
  publication_date    date,
  publication_precision core.date_precision NOT NULL DEFAULT 'unknown',
  -- NULL means nobody has accessed it yet; such a source cannot support verification.
  accessed_at         date,
  document_identifier text CHECK (length(document_identifier) <= 200),
  document_version    text CHECK (length(document_version) <= 200),
  archived_url        text CHECK (core.valid_url(archived_url)),
  availability        core.source_availability NOT NULL DEFAULT 'unknown',
  source_notes        text CHECK (length(source_notes) <= 3000),  -- internal
  created_by          integer NOT NULL REFERENCES core.app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (core.valid_dated(publication_date, publication_precision)),
  CHECK (accessed_at IS NULL OR accessed_at <= current_date + 1)
);
CREATE INDEX source_url_idx ON core.source (canonical_url);

CREATE TABLE core.claim_source (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id            bigint NOT NULL REFERENCES core.claim(id),
  source_id           integer NOT NULL REFERENCES core.source(id),
  evidence_role       core.evidence_role NOT NULL DEFAULT 'supports',
  relevant_section    text CHECK (length(relevant_section) <= 300),
  -- Brief, accurate excerpt (kept short for lawful quotation) or a precise description.
  supporting_excerpt  text CHECK (length(supporting_excerpt) <= 600),
  passage_description text CHECK (length(passage_description) <= 1000),
  verification_notes  text CHECK (length(verification_notes) <= 3000),   -- internal
  -- Set only when a human reviewer confirms they accessed the source and read the passage.
  checked_by          integer REFERENCES core.app_user(id),
  checked_at          timestamptz,
  CHECK ((checked_by IS NULL) = (checked_at IS NULL)),
  UNIQUE (claim_id, source_id, relevant_section)
);
CREATE INDEX claim_source_claim_idx ON core.claim_source (claim_id);
CREATE INDEX claim_source_source_idx ON core.claim_source (source_id);

-- ---------------------------------------------------------------------------
-- Reviews, corrections, audit
-- ---------------------------------------------------------------------------
CREATE TABLE core.review (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id    bigint NOT NULL REFERENCES core.claim(id),
  reviewer_id integer NOT NULL REFERENCES core.app_user(id),
  from_status core.claim_status NOT NULL,
  to_status   core.claim_status NOT NULL,
  notes       text CHECK (length(notes) <= 5000),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_claim_idx ON core.review (claim_id);

CREATE TABLE core.correction_request (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_ref         text GENERATED ALWAYS AS ('R-' || lpad(id::text, 5, '0')) STORED UNIQUE,
  claim_public_id    text CHECK (claim_public_id ~ '^C-[0-9]{6}$'),
  page_path          text CHECK (length(page_path) <= 300),
  message            text NOT NULL CHECK (length(message) BETWEEN 10 AND 5000),
  submitter_name     text CHECK (length(submitter_name) <= 120),
  submitter_contact  text CHECK (length(submitter_contact) <= 200),
  status             core.correction_status NOT NULL DEFAULT 'received',
  resolution_notes   text CHECK (length(resolution_notes) <= 5000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type    text NOT NULL,
  entity_id      text NOT NULL,
  action         text NOT NULL CHECK (action IN ('insert','update','delete')),
  previous_value jsonb,
  new_value      jsonb,
  changed_by     integer REFERENCES core.app_user(id),
  changed_at     timestamptz NOT NULL DEFAULT now(),
  reason         text
);
CREATE INDEX audit_entity_idx ON core.audit_log (entity_type, entity_id);
