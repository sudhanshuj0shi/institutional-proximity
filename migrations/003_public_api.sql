-- Institutional Proximity — the public boundary.
-- The public web server connects as ip_public, which can read ONLY these views.
-- Every view filters to published claims whose referenced entities are also public.
-- Internal notes, reviewer identities and unpublished records are never selected here.

-- Internal building blocks (owned by the migration owner; ip_public has no access to core).
CREATE VIEW core.v_published_claim AS
  SELECT * FROM core.claim WHERE status = 'published';

CREATE VIEW core.v_public_institution AS
  SELECT DISTINCT subject_institution_id AS id FROM core.v_published_claim
  WHERE kind = 'identity' AND subject_institution_id IS NOT NULL;

CREATE VIEW core.v_public_person AS
  SELECT DISTINCT subject_person_id AS id FROM core.v_published_claim
  WHERE kind = 'identity' AND subject_person_id IS NOT NULL;

-- ---------------------------------------------------------------------------
CREATE VIEW public_api.institutions AS
SELECT i.id, i.slug, i.canonical_name, i.short_name, i.entity_kind, i.legal_category, i.official_website,
       (SELECT max(c.last_verified_at) FROM core.v_published_claim c WHERE c.subject_institution_id = i.id) AS last_verified_at,
       (SELECT count(*) FROM core.v_published_claim c WHERE c.subject_institution_id = i.id) AS published_claim_count
FROM core.institution i
WHERE i.id IN (SELECT id FROM core.v_public_institution);

CREATE VIEW public_api.people AS
SELECT p.id, p.slug, p.canonical_name,
       (SELECT max(c.last_verified_at) FROM core.v_published_claim c WHERE c.subject_person_id = p.id) AS last_verified_at
FROM core.person p
WHERE p.id IN (SELECT id FROM core.v_public_person);

CREATE VIEW public_api.claims AS
SELECT c.public_id, c.kind, c.claim_text, c.claim_category, c.temporal_scope, c.known_limitations,
       c.last_verified_at, c.published_at,
       i.slug AS institution_slug, i.canonical_name AS institution_name,
       p.slug AS person_slug, p.canonical_name AS person_name,
       sc.public_id AS corrects_claim_id
FROM core.v_published_claim c
LEFT JOIN core.institution i ON i.id = c.subject_institution_id
LEFT JOIN core.person p ON p.id = c.subject_person_id
LEFT JOIN core.claim sc ON sc.id = c.supersedes_claim_id AND sc.published_at IS NOT NULL
WHERE (c.subject_institution_id IN (SELECT id FROM core.v_public_institution)
    OR c.subject_person_id IN (SELECT id FROM core.v_public_person));

CREATE VIEW public_api.claim_evidence AS
SELECT c.public_id AS claim_id, cs.evidence_role, cs.relevant_section, cs.supporting_excerpt,
       cs.passage_description, cs.checked_at::date AS confirmed_on,
       s.public_id AS source_id, s.title, s.publisher, s.canonical_url, s.source_type, s.tier,
       s.publication_date, s.publication_precision, s.accessed_at, s.document_identifier,
       s.document_version, s.archived_url, s.availability
FROM core.claim_source cs
JOIN core.v_published_claim c ON c.id = cs.claim_id
JOIN core.source s ON s.id = cs.source_id
WHERE c.public_id IN (SELECT public_id FROM public_api.claims);

CREATE VIEW public_api.positions AS
SELECT po.id, c.public_id AS claim_id,
       pe.id AS person_id, pe.slug AS person_slug, pe.canonical_name AS person_name,
       i.id AS institution_id, i.slug AS institution_slug, i.canonical_name AS institution_name,
       i.entity_kind AS institution_kind,
       po.title, po.start_date, po.start_precision, po.end_date, po.end_precision, po.ongoing_as_of,
       po.appointment_type,
       a.id AS appointing_authority_id, a.slug AS appointing_authority_slug,
       a.canonical_name AS appointing_authority_name
FROM core.position po
JOIN core.v_published_claim c ON c.id = po.claim_id
JOIN core.person pe ON pe.id = po.person_id
JOIN core.institution i ON i.id = po.institution_id
LEFT JOIN core.institution a ON a.id = po.appointing_authority_id
WHERE po.person_id IN (SELECT id FROM core.v_public_person)
  AND po.institution_id IN (SELECT id FROM core.v_public_institution)
  AND (po.appointing_authority_id IS NULL OR po.appointing_authority_id IN (SELECT id FROM core.v_public_institution));

CREATE VIEW public_api.relationships AS
SELECT r.id, c.public_id AS claim_id, r.relationship_type, r.description,
       CASE WHEN r.source_person_id IS NOT NULL THEN 'person' ELSE 'institution' END AS source_type,
       coalesce(r.source_person_id, r.source_institution_id) AS source_id,
       coalesce(sp.slug, si.slug) AS source_slug, coalesce(sp.canonical_name, si.canonical_name) AS source_name,
       CASE WHEN r.target_person_id IS NOT NULL THEN 'person' ELSE 'institution' END AS target_type,
       coalesce(r.target_person_id, r.target_institution_id) AS target_id,
       coalesce(tp.slug, ti.slug) AS target_slug, coalesce(tp.canonical_name, ti.canonical_name) AS target_name,
       r.valid_from, r.valid_from_precision, r.valid_until, r.valid_until_precision
FROM core.relationship r
JOIN core.v_published_claim c ON c.id = r.claim_id
LEFT JOIN core.person sp ON sp.id = r.source_person_id
LEFT JOIN core.institution si ON si.id = r.source_institution_id
LEFT JOIN core.person tp ON tp.id = r.target_person_id
LEFT JOIN core.institution ti ON ti.id = r.target_institution_id
WHERE (r.source_person_id IN (SELECT id FROM core.v_public_person) OR r.source_institution_id IN (SELECT id FROM core.v_public_institution))
  AND (r.target_person_id IN (SELECT id FROM core.v_public_person) OR r.target_institution_id IN (SELECT id FROM core.v_public_institution));

CREATE VIEW public_api.appointment_processes AS
SELECT ap.id, c.public_id AS claim_id, i.slug AS institution_slug, ap.office_title, ap.legal_basis,
       ap.process_description, ap.effective_from, ap.effective_from_precision,
       ap.effective_until, ap.effective_until_precision
FROM core.appointment_process ap
JOIN core.v_published_claim c ON c.id = ap.claim_id
JOIN core.institution i ON i.id = ap.institution_id
WHERE ap.institution_id IN (SELECT id FROM core.v_public_institution);

CREATE VIEW public_api.appointment_stages AS
SELECT st.id, c.public_id AS claim_id, st.process_id, st.seq, st.stage_title, st.actor_label,
       st.role_description, st.provision_label,
       a.id AS actor_institution_id, a.slug AS actor_institution_slug, a.canonical_name AS actor_institution_name
FROM core.appointment_stage st
JOIN core.v_published_claim c ON c.id = st.claim_id
LEFT JOIN core.institution a ON a.id = st.actor_institution_id
WHERE st.process_id IN (SELECT id FROM public_api.appointment_processes)
  AND (st.actor_institution_id IS NULL OR st.actor_institution_id IN (SELECT id FROM core.v_public_institution));

CREATE VIEW public_api.safeguards AS
SELECT sg.id, c.public_id AS claim_id, i.slug AS institution_slug, sg.dimension, sg.provision_label,
       sg.establishes, sg.does_not_establish, sg.limitations, c.last_verified_at
FROM core.safeguard sg
JOIN core.v_published_claim c ON c.id = sg.claim_id
JOIN core.institution i ON i.id = sg.institution_id
WHERE sg.institution_id IN (SELECT id FROM core.v_public_institution);

CREATE VIEW public_api.legal_events AS
SELECT le.id, c.public_id AS claim_id, i.slug AS institution_slug, i.canonical_name AS institution_name,
       le.event_type, le.title, le.event_date, le.event_precision, le.procedural_status,
       CASE WHEN rc.status = 'published' THEN rle.id END AS related_event_id,
       CASE WHEN rc.status = 'published' THEN le.relation_to_related END AS relation_to_related,
       c.published_at
FROM core.legal_event le
JOIN core.v_published_claim c ON c.id = le.claim_id
LEFT JOIN core.institution i ON i.id = le.institution_id
LEFT JOIN core.legal_event rle ON rle.id = le.related_event_id
LEFT JOIN core.claim rc ON rc.id = rle.claim_id
WHERE le.institution_id IS NULL OR le.institution_id IN (SELECT id FROM core.v_public_institution);

-- Claims that were once public and no longer are. The original text is deliberately NOT
-- exposed, so a withdrawn statement is never re-published as fact.
CREATE VIEW public_api.withdrawals AS
SELECT c.public_id AS claim_id, c.kind,
       CASE WHEN c.status = 'retracted' THEN 'withdrawn' ELSE 'temporarily_withdrawn' END AS withdrawal_type,
       CASE WHEN c.subject_institution_id IN (SELECT id FROM core.v_public_institution) THEN i.canonical_name END AS institution_name,
       CASE WHEN c.subject_person_id IN (SELECT id FROM core.v_public_person) THEN p.canonical_name END AS person_name,
       CASE WHEN c.status = 'retracted' THEN c.public_correction_note END AS public_correction_note,
       coalesce(c.retracted_at, c.updated_at) AS withdrawn_at,
       (SELECT n.public_id FROM core.v_published_claim n WHERE n.supersedes_claim_id = c.id LIMIT 1) AS replaced_by_claim_id
FROM core.claim c
LEFT JOIN core.institution i ON i.id = c.subject_institution_id
LEFT JOIN core.person p ON p.id = c.subject_person_id
WHERE c.published_at IS NOT NULL
  AND c.status IN ('retracted', 'needs_reverification', 'disputed');

-- Aggregate research coverage per institution (counts only, no content).
CREATE VIEW public_api.coverage AS
SELECT i.slug,
       count(*) FILTER (WHERE c.status = 'published') AS published,
       count(*) FILTER (WHERE c.status IN ('draft','researching','pending_review','verified')) AS in_progress
FROM core.institution i
LEFT JOIN core.claim c ON c.subject_institution_id = i.id
WHERE i.id IN (SELECT id FROM core.v_public_institution)
GROUP BY i.slug;

-- Site-wide counts so empty states can be honest ("N claims are awaiting review").
CREATE VIEW public_api.site_status AS
SELECT
  (SELECT count(*) FROM core.claim WHERE status = 'published') AS published_claims,
  (SELECT count(*) FROM core.claim WHERE status IN ('pending_review','verified')) AS awaiting_review,
  (SELECT count(*) FROM core.claim WHERE status IN ('draft','researching')) AS in_research;

-- ---------------------------------------------------------------------------
-- The only public write path: correction requests. Never published automatically.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public_api.submit_correction(
  p_claim_public_id text, p_page_path text, p_message text, p_name text, p_contact text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
DECLARE ref text;
BEGIN
  INSERT INTO core.correction_request (claim_public_id, page_path, message, submitter_name, submitter_contact)
  VALUES (nullif(btrim(p_claim_public_id), ''), nullif(btrim(p_page_path), ''), btrim(p_message),
          nullif(btrim(p_name), ''), nullif(btrim(p_contact), ''))
  RETURNING public_ref INTO ref;
  RETURN ref;
END $$;

-- ---------------------------------------------------------------------------
-- Roles and grants
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ip_public') THEN CREATE ROLE ip_public NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ip_editor') THEN CREATE ROLE ip_editor NOLOGIN; END IF;
END $$;

REVOKE ALL ON SCHEMA core FROM PUBLIC;
REVOKE ALL ON SCHEMA public_api FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA core FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public_api FROM PUBLIC;

-- Public: read published views, submit corrections. Nothing else.
GRANT USAGE ON SCHEMA public_api TO ip_public;
GRANT SELECT ON ALL TABLES IN SCHEMA public_api TO ip_public;
GRANT EXECUTE ON FUNCTION public_api.submit_correction(text, text, text, text, text) TO ip_public;

-- Editor: work on core tables under trigger rules. No TRUNCATE, no audit/review rewriting.
GRANT USAGE ON SCHEMA core, public_api TO ip_editor;
GRANT SELECT ON ALL TABLES IN SCHEMA public_api TO ip_editor;
GRANT EXECUTE ON FUNCTION public_api.submit_correction(text, text, text, text, text) TO ip_editor;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core TO ip_editor;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  core.institution, core.person, core.claim, core.position, core.relationship,
  core.appointment_process, core.appointment_stage, core.safeguard, core.legal_event,
  core.source, core.claim_source, core.session
TO ip_editor;
GRANT SELECT, UPDATE ON core.correction_request TO ip_editor;
GRANT SELECT, INSERT, UPDATE ON core.app_user TO ip_editor;
GRANT SELECT ON core.review, core.audit_log, core.v_published_claim, core.v_public_institution, core.v_public_person TO ip_editor;

-- ---------------------------------------------------------------------------
-- User management: through the app only an admin may create or change users.
-- The owner (CLI bootstrap) may act without an app actor.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.app_user_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actor core.app_user;
BEGIN
  IF core.current_actor() IS NULL THEN
    IF current_user = 'ip_editor' THEN
      RAISE EXCEPTION 'User management requires an admin actor.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  actor := core.require_actor();
  -- Users may update nothing about themselves except via admin; admins manage everyone.
  IF NOT core.has_role(actor, 'admin') THEN
    RAISE EXCEPTION 'Only admins can manage editorial users.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.id = actor.id AND NOT ('admin' = ANY(NEW.roles)) THEN
    RAISE EXCEPTION 'Admins cannot remove their own admin role.' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION core.app_user_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.app_user_guard() TO ip_editor;
CREATE TRIGGER app_user_guard BEFORE INSERT OR UPDATE ON core.app_user
  FOR EACH ROW EXECUTE FUNCTION core.app_user_guard();
