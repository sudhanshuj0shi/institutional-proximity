-- Two levels of checking, always disclosed publicly:
--   'human' – a person opened each supporting source and confirmed the passage.
--   'ai'    – an automated reviewer did so. Labelled on every public display.
-- Sensitive claims can only ever be checked by a person.

ALTER TABLE core.claim ADD COLUMN verification_basis text CHECK (verification_basis IN ('human', 'ai'));
ALTER TABLE core.claim_source ADD COLUMN check_basis text CHECK (check_basis IN ('human', 'ai'));
ALTER TABLE core.claim_source ADD CONSTRAINT check_basis_present CHECK ((checked_by IS NULL) = (check_basis IS NULL));

-- Refresh the internal view so it carries the new column (SELECT * is fixed at creation).
CREATE OR REPLACE VIEW core.v_published_claim AS SELECT * FROM core.claim WHERE status = 'published';

ALTER TABLE core.app_user ADD CONSTRAINT ai_reviewer_is_not_human
  CHECK (NOT is_human OR NOT ('ai_reviewer' = ANY(roles)));

-- Evidence completeness no longer cares WHO checked; the transition trigger does.
CREATE OR REPLACE FUNCTION core.claim_evidence_problems(p_claim bigint, p_target core.claim_status)
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
DECLARE
  c core.claim;
  probs text[] := '{}';
  n integer;
  max_tier smallint;
  pos core.position;
  rel core.relationship;
  stg core.appointment_stage;
BEGIN
  SELECT * INTO c FROM core.claim WHERE id = p_claim;
  IF NOT FOUND THEN RETURN ARRAY['Claim not found.']; END IF;

  SELECT count(*) INTO n FROM core.claim_source WHERE claim_id = p_claim AND evidence_role = 'supports';
  IF n = 0 THEN probs := probs || 'No supporting source is attached.'::text; END IF;

  max_tier := CASE WHEN c.is_sensitive THEN 1 ELSE 2 END;
  IF n > 0 AND NOT EXISTS (
      SELECT 1 FROM core.claim_source cs JOIN core.source s ON s.id = cs.source_id
      WHERE cs.claim_id = p_claim AND cs.evidence_role = 'supports' AND s.tier <= max_tier) THEN
    probs := probs || CASE WHEN c.is_sensitive
      THEN 'Sensitive claims need a primary (tier 1) supporting source.'
      ELSE 'At least one supporting source must be tier 1 or tier 2. Discovery sources cannot establish a claim.' END;
  END IF;

  SELECT count(*) INTO n FROM core.claim_source
   WHERE claim_id = p_claim AND evidence_role = 'supports' AND coalesce(btrim(relevant_section), '') = '';
  IF n > 0 THEN probs := probs || format('%s supporting link(s) lack a page, article, section or paragraph reference.', n); END IF;

  SELECT count(*) INTO n FROM core.claim_source
   WHERE claim_id = p_claim AND evidence_role = 'supports'
     AND coalesce(btrim(supporting_excerpt), '') = '' AND coalesce(btrim(passage_description), '') = '';
  IF n > 0 THEN probs := probs || format('%s supporting link(s) have neither an excerpt nor a description of the passage.', n); END IF;

  SELECT count(*) INTO n FROM core.claim_source cs JOIN core.source s ON s.id = cs.source_id
   WHERE cs.claim_id = p_claim AND cs.evidence_role = 'supports' AND s.accessed_at IS NULL;
  IF n > 0 THEN probs := probs || format('%s supporting source(s) have no recorded access date.', n); END IF;

  SELECT count(*) INTO n FROM core.claim_source cs JOIN core.source s ON s.id = cs.source_id
   WHERE cs.claim_id = p_claim AND cs.evidence_role = 'supports' AND s.availability = 'unavailable';
  IF n > 0 THEN probs := probs || format('%s supporting source(s) are marked unavailable.', n); END IF;

  SELECT count(*) INTO n FROM core.claim_source
   WHERE claim_id = p_claim AND evidence_role = 'supports' AND checked_by IS NULL;
  IF n > 0 THEN probs := probs || format('%s supporting link(s) have not been confirmed by a reviewer who opened the source.', n); END IF;

  IF EXISTS (SELECT 1 FROM core.claim_source WHERE claim_id = p_claim AND evidence_role = 'contradicts')
     AND coalesce(btrim(c.known_limitations), '') = '' THEN
    probs := probs || 'Contradictory evidence is attached; describe it under known limitations.'::text;
  END IF;

  IF c.kind = 'position' AND NOT EXISTS (SELECT 1 FROM core.position WHERE claim_id = p_claim)
     OR c.kind = 'relationship' AND NOT EXISTS (SELECT 1 FROM core.relationship WHERE claim_id = p_claim)
     OR c.kind = 'appointment_process' AND NOT EXISTS (SELECT 1 FROM core.appointment_process WHERE claim_id = p_claim)
     OR c.kind = 'appointment_stage' AND NOT EXISTS (SELECT 1 FROM core.appointment_stage WHERE claim_id = p_claim)
     OR c.kind = 'safeguard' AND NOT EXISTS (SELECT 1 FROM core.safeguard WHERE claim_id = p_claim)
     OR c.kind = 'legal_event' AND NOT EXISTS (SELECT 1 FROM core.legal_event WHERE claim_id = p_claim) THEN
    probs := probs || format('This %s claim has no %s record attached.', c.kind, c.kind);
  END IF;

  IF p_target = 'published' THEN
    IF c.claim_category NOT IN ('verified_fact', 'official_finding') THEN
      probs := probs || format('Only verified facts and official findings can be published in this version (this claim is "%s").', c.claim_category);
    END IF;
    IF c.kind <> 'identity' THEN
      IF c.subject_institution_id IS NOT NULL AND NOT core.institution_is_public(c.subject_institution_id) THEN
        probs := probs || 'The subject institution has no published identity claim yet.'::text;
      END IF;
      IF c.subject_person_id IS NOT NULL AND NOT core.person_is_public(c.subject_person_id) THEN
        probs := probs || 'The subject person has no published identity claim yet.'::text;
      END IF;
    END IF;
    SELECT * INTO pos FROM core.position WHERE claim_id = p_claim;
    IF FOUND THEN
      IF NOT core.person_is_public(pos.person_id) THEN probs := probs || 'The officeholder has no published identity claim yet.'::text; END IF;
      IF NOT core.institution_is_public(pos.institution_id) THEN probs := probs || 'The institution of this position has no published identity claim yet.'::text; END IF;
      IF pos.appointing_authority_id IS NOT NULL AND NOT core.institution_is_public(pos.appointing_authority_id) THEN
        probs := probs || 'The appointing authority has no published identity claim yet.'::text;
      END IF;
    END IF;
    SELECT * INTO rel FROM core.relationship WHERE claim_id = p_claim;
    IF FOUND THEN
      IF NOT (core.person_is_public(rel.source_person_id) OR core.institution_is_public(rel.source_institution_id)) THEN
        probs := probs || 'The relationship''s source entity has no published identity claim yet.'::text;
      END IF;
      IF NOT (core.person_is_public(rel.target_person_id) OR core.institution_is_public(rel.target_institution_id)) THEN
        probs := probs || 'The relationship''s target entity has no published identity claim yet.'::text;
      END IF;
    END IF;
    SELECT * INTO stg FROM core.appointment_stage WHERE claim_id = p_claim;
    IF FOUND THEN
      IF NOT EXISTS (SELECT 1 FROM core.appointment_process ap JOIN core.claim pc ON pc.id = ap.claim_id
                     WHERE ap.id = stg.process_id AND pc.status = 'published') THEN
        probs := probs || 'The appointment process this stage belongs to is not published yet.'::text;
      END IF;
      IF stg.actor_institution_id IS NOT NULL AND NOT core.institution_is_public(stg.actor_institution_id) THEN
        probs := probs || 'The stage''s actor institution has no published identity claim yet.'::text;
      END IF;
    END IF;
  END IF;
  RETURN probs;
END $$;

CREATE OR REPLACE FUNCTION core.claim_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor core.app_user := core.require_actor();
  needed text;
  probs text[];
  ai_ok boolean;
BEGIN
  IF NOT core.is_editor(actor) THEN
    RAISE EXCEPTION 'Only editorial users can change claims.' USING ERRCODE = '42501';
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.subject_institution_id IS DISTINCT FROM OLD.subject_institution_id
     OR NEW.subject_person_id IS DISTINCT FROM OLD.subject_person_id THEN
    RAISE EXCEPTION 'A claim''s kind and subject cannot change. Create a new claim instead.' USING ERRCODE = '23514';
  END IF;

  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  NEW.last_verified_at := OLD.last_verified_at;
  NEW.published_at := OLD.published_at;
  NEW.retracted_at := OLD.retracted_at;
  NEW.verification_basis := OLD.verification_basis;
  NEW.updated_at := now();

  IF OLD.status IN ('verified', 'published', 'retracted') AND (
       NEW.claim_text, NEW.claim_category, NEW.is_sensitive, NEW.temporal_scope,
       NEW.known_limitations, NEW.supersedes_claim_id
     ) IS DISTINCT FROM (
       OLD.claim_text, OLD.claim_category, OLD.is_sensitive, OLD.temporal_scope,
       OLD.known_limitations, OLD.supersedes_claim_id) THEN
    RAISE EXCEPTION 'Claim % is %. Move it to needs_reverification before changing its content.',
      OLD.public_id, OLD.status USING ERRCODE = '55000';
  END IF;

  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  needed := core.transition_role(OLD.status, NEW.status);
  IF needed IS NULL THEN
    RAISE EXCEPTION 'Transition % → % is not permitted.', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  -- An AI reviewer may stand in for reviewer/publisher only to verify or publish.
  ai_ok := core.has_role(actor, 'ai_reviewer') AND NOT actor.is_human AND NEW.status IN ('verified', 'published');
  IF needed = 'reviewer' AND NOT (core.has_role(actor, 'reviewer') OR ai_ok)
     OR needed = 'publisher' AND NOT (core.has_role(actor, 'publisher') OR ai_ok) THEN
    RAISE EXCEPTION 'Transition % → % requires the % role.', OLD.status, NEW.status, needed USING ERRCODE = '42501';
  END IF;

  IF NEW.status IN ('verified', 'published') THEN
    IF NOT actor.is_human THEN
      IF NOT ai_ok THEN
        RAISE EXCEPTION 'Automated accounts cannot verify or publish claims.' USING ERRCODE = '42501';
      END IF;
      IF OLD.is_sensitive THEN
        RAISE EXCEPTION 'Sensitive claims must be verified and published by a person.' USING ERRCODE = '42501';
      END IF;
      IF NEW.status = 'published' AND OLD.verification_basis IS DISTINCT FROM 'ai' AND OLD.verification_basis IS NOT NULL THEN
        RAISE EXCEPTION 'An automated reviewer cannot publish a claim verified by a person; a publisher must.' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.status = 'verified' AND actor.id = OLD.created_by THEN
      RAISE EXCEPTION 'A claim must be verified by someone other than its author.' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'verified' AND actor.is_human AND EXISTS (
        SELECT 1 FROM core.claim_source WHERE claim_id = OLD.id AND evidence_role = 'supports' AND check_basis = 'ai') THEN
      RAISE EXCEPTION 'A person''s verification needs every supporting source confirmed by a person. Re-confirm the sources checked by AI.' USING ERRCODE = '23514';
    END IF;
    probs := core.claim_evidence_problems(OLD.id, NEW.status);
    IF array_length(probs, 1) > 0 THEN
      RAISE EXCEPTION 'Claim % is not eligible for %: %', OLD.public_id, NEW.status, array_to_string(probs, ' ')
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'retracted' AND OLD.published_at IS NOT NULL
     AND coalesce(btrim(NEW.public_correction_note), '') = '' THEN
    RAISE EXCEPTION 'Withdrawing a previously published claim requires a public correction note.' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'verified' THEN
    NEW.last_verified_at := now();
    NEW.attention_reason := NULL;
    NEW.verification_basis := CASE WHEN actor.is_human THEN 'human' ELSE 'ai' END;
  END IF;
  IF NEW.status = 'published' THEN NEW.published_at := now(); END IF;
  IF NEW.status = 'retracted' THEN NEW.retracted_at := now(); END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION core.claim_source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor core.app_user := core.require_actor();
  st core.claim_status;
  pid text;
BEGIN
  IF NOT core.is_editor(actor) THEN
    RAISE EXCEPTION 'Only editorial users can change evidence links.' USING ERRCODE = '42501';
  END IF;
  SELECT status, public_id INTO st, pid FROM core.claim
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.claim_id ELSE NEW.claim_id END;
  IF st IN ('verified', 'published', 'retracted') THEN
    RAISE EXCEPTION 'Evidence for % is locked while the claim is %.', pid, st USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.checked_by := NULL; NEW.checked_at := NULL; NEW.check_basis := NULL;
    RETURN NEW;
  END IF;

  IF NEW.claim_id <> OLD.claim_id THEN
    RAISE EXCEPTION 'Evidence links cannot be moved between claims.' USING ERRCODE = '23514';
  END IF;

  IF (NEW.source_id, NEW.evidence_role, NEW.relevant_section, NEW.supporting_excerpt, NEW.passage_description)
     IS DISTINCT FROM
     (OLD.source_id, OLD.evidence_role, OLD.relevant_section, OLD.supporting_excerpt, OLD.passage_description) THEN
    NEW.checked_by := NULL; NEW.checked_at := NULL; NEW.check_basis := NULL;
    RETURN NEW;
  END IF;

  IF NEW.checked_by IS DISTINCT FROM OLD.checked_by AND NEW.checked_by IS NOT NULL THEN
    IF NEW.checked_by <> actor.id OR NOT (
         (actor.is_human AND core.has_role(actor, 'reviewer'))
         OR (NOT actor.is_human AND core.has_role(actor, 'ai_reviewer'))) THEN
      RAISE EXCEPTION 'Only a reviewer can confirm a source check, and only for themselves.' USING ERRCODE = '42501';
    END IF;
    NEW.checked_at := now();
    NEW.check_basis := CASE WHEN actor.is_human THEN 'human' ELSE 'ai' END;
  ELSIF NEW.checked_by IS NULL THEN
    NEW.checked_at := NULL; NEW.check_basis := NULL;
  ELSE
    NEW.checked_at := OLD.checked_at; NEW.check_basis := OLD.check_basis;
  END IF;
  RETURN NEW;
END $$;

-- Public views gain the basis columns (appended so dependent views stay valid).
CREATE OR REPLACE VIEW public_api.claims AS
SELECT c.public_id, c.kind, c.claim_text, c.claim_category, c.temporal_scope, c.known_limitations,
       c.last_verified_at, c.published_at,
       i.slug AS institution_slug, i.canonical_name AS institution_name,
       p.slug AS person_slug, p.canonical_name AS person_name,
       sc.public_id AS corrects_claim_id,
       c.verification_basis
FROM core.v_published_claim c
LEFT JOIN core.institution i ON i.id = c.subject_institution_id
LEFT JOIN core.person p ON p.id = c.subject_person_id
LEFT JOIN core.claim sc ON sc.id = c.supersedes_claim_id AND sc.published_at IS NOT NULL
WHERE (c.subject_institution_id IN (SELECT id FROM core.v_public_institution)
    OR c.subject_person_id IN (SELECT id FROM core.v_public_person));

CREATE OR REPLACE VIEW public_api.claim_evidence AS
SELECT c.public_id AS claim_id, cs.evidence_role, cs.relevant_section, cs.supporting_excerpt,
       cs.passage_description, cs.checked_at::date AS confirmed_on,
       s.public_id AS source_id, s.title, s.publisher, s.canonical_url, s.source_type, s.tier,
       s.publication_date, s.publication_precision, s.accessed_at, s.document_identifier,
       s.document_version, s.archived_url, s.availability,
       cs.check_basis
FROM core.claim_source cs
JOIN core.v_published_claim c ON c.id = cs.claim_id
JOIN core.source s ON s.id = cs.source_id
WHERE c.public_id IN (SELECT public_id FROM public_api.claims);

CREATE OR REPLACE VIEW public_api.site_status AS
SELECT
  (SELECT count(*) FROM core.claim WHERE status = 'published') AS published_claims,
  (SELECT count(*) FROM core.claim WHERE status IN ('pending_review','verified')) AS awaiting_review,
  (SELECT count(*) FROM core.claim WHERE status IN ('draft','researching')) AS in_research,
  (SELECT count(*) FROM core.claim WHERE status = 'published' AND verification_basis = 'ai') AS published_ai_checked;

GRANT SELECT ON ALL TABLES IN SCHEMA public_api TO ip_public, ip_editor;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core TO ip_editor;
