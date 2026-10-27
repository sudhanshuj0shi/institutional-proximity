-- Institutional Proximity — publication rules enforced inside the database.
-- These triggers are the authoritative gate. Application code repeats some checks only
-- to give friendly messages; it is never the only line of defence.

-- Automated / AI accounts can never hold reviewing or publishing roles.
ALTER TABLE core.app_user ADD CONSTRAINT non_human_cannot_review
  CHECK (is_human OR NOT (roles && ARRAY['reviewer','publisher','admin']::core.user_role[]));

-- ---------------------------------------------------------------------------
-- Actor (set per transaction by the application: SET LOCAL app.user_id = …)
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.current_actor() RETURNS integer
LANGUAGE plpgsql STABLE AS $$
DECLARE v text := current_setting('app.user_id', true);
BEGIN
  IF v IS NULL OR v = '' THEN RETURN NULL; END IF;
  RETURN v::integer;
END $$;

CREATE FUNCTION core.require_actor() RETURNS core.app_user
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
DECLARE u core.app_user;
BEGIN
  SELECT * INTO u FROM core.app_user WHERE id = core.current_actor() AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active editorial user is attached to this change.' USING ERRCODE = '42501';
  END IF;
  RETURN u;
END $$;

CREATE FUNCTION core.has_role(u core.app_user, r core.user_role) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT u.active AND r = ANY(u.roles) $$;

CREATE FUNCTION core.is_editor(u core.app_user) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT u.active AND u.roles && ARRAY['researcher','reviewer','publisher']::core.user_role[]
$$;

-- ---------------------------------------------------------------------------
-- Visibility helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.institution_is_public(p_id integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM core.claim c
    WHERE c.kind = 'identity' AND c.subject_institution_id = p_id AND c.status = 'published')
$$;

CREATE FUNCTION core.person_is_public(p_id integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM core.claim c
    WHERE c.kind = 'identity' AND c.subject_person_id = p_id AND c.status = 'published')
$$;

CREATE FUNCTION core.claim_is_public(p_id bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM core.claim WHERE id = p_id AND status = 'published')
$$;

-- ---------------------------------------------------------------------------
-- Evidence requirements. Returns human-readable problems; empty array = eligible.
-- Used by the transition trigger AND by the editorial UI checklist.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.claim_evidence_problems(p_claim bigint, p_target core.claim_status)
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
  IF n = 0 THEN
    probs := probs || 'No supporting source is attached.'::text;
  END IF;

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
  IF n > 0 THEN
    probs := probs || format('%s supporting link(s) lack a page, article, section or paragraph reference.', n);
  END IF;

  SELECT count(*) INTO n FROM core.claim_source
   WHERE claim_id = p_claim AND evidence_role = 'supports'
     AND coalesce(btrim(supporting_excerpt), '') = '' AND coalesce(btrim(passage_description), '') = '';
  IF n > 0 THEN
    probs := probs || format('%s supporting link(s) have neither an excerpt nor a description of the passage.', n);
  END IF;

  SELECT count(*) INTO n FROM core.claim_source cs JOIN core.source s ON s.id = cs.source_id
   WHERE cs.claim_id = p_claim AND cs.evidence_role = 'supports' AND s.accessed_at IS NULL;
  IF n > 0 THEN
    probs := probs || format('%s supporting source(s) have no recorded access date.', n);
  END IF;

  SELECT count(*) INTO n FROM core.claim_source cs JOIN core.source s ON s.id = cs.source_id
   WHERE cs.claim_id = p_claim AND cs.evidence_role = 'supports' AND s.availability = 'unavailable';
  IF n > 0 THEN
    probs := probs || format('%s supporting source(s) are marked unavailable.', n);
  END IF;

  SELECT count(*) INTO n FROM core.claim_source cs LEFT JOIN core.app_user u ON u.id = cs.checked_by
   WHERE cs.claim_id = p_claim AND cs.evidence_role = 'supports'
     AND (cs.checked_by IS NULL OR NOT u.is_human);
  IF n > 0 THEN
    probs := probs || format('%s supporting link(s) have not been confirmed by a human reviewer who accessed the source.', n);
  END IF;

  IF EXISTS (SELECT 1 FROM core.claim_source WHERE claim_id = p_claim AND evidence_role = 'contradicts')
     AND coalesce(btrim(c.known_limitations), '') = '' THEN
    probs := probs || 'Contradictory evidence is attached; describe it under known limitations.'::text;
  END IF;

  -- The structured record a claim backs must exist.
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

-- ---------------------------------------------------------------------------
-- Lifecycle: which transitions exist and who may make them.
-- Returns the role class required, or NULL if the transition does not exist.
--   'editor'    – any of researcher / reviewer / publisher
--   'reviewer'  – reviewer role
--   'publisher' – publisher role
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.transition_role(f core.claim_status, t core.claim_status) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN f = 'draft'                AND t IN ('researching','pending_review') THEN 'editor'
    WHEN f = 'researching'          AND t IN ('draft','pending_review')       THEN 'editor'
    WHEN f = 'pending_review'       AND t = 'researching'                     THEN 'editor'
    WHEN f = 'pending_review'       AND t = 'verified'                        THEN 'reviewer'
    WHEN f = 'pending_review'       AND t = 'disputed'                        THEN 'reviewer'
    WHEN f = 'pending_review'       AND t = 'retracted'                       THEN 'publisher'
    WHEN f = 'verified'             AND t = 'published'                       THEN 'publisher'
    WHEN f = 'verified'             AND t = 'researching'                     THEN 'reviewer'
    WHEN f = 'verified'             AND t IN ('needs_reverification','disputed') THEN 'editor'
    WHEN f = 'verified'             AND t = 'retracted'                       THEN 'publisher'
    -- Hiding a published claim is always allowed to any editor: it can only reduce exposure.
    WHEN f = 'published'            AND t IN ('needs_reverification','disputed') THEN 'editor'
    WHEN f = 'published'            AND t = 'retracted'                       THEN 'publisher'
    WHEN f = 'needs_reverification' AND t IN ('pending_review','researching') THEN 'editor'
    WHEN f = 'needs_reverification' AND t = 'retracted'                       THEN 'publisher'
    WHEN f = 'disputed'             AND t = 'pending_review'                  THEN 'reviewer'
    WHEN f = 'disputed'             AND t = 'retracted'                       THEN 'publisher'
    ELSE NULL  -- includes everything out of 'retracted' (terminal)
  END
$$;

CREATE FUNCTION core.claim_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actor core.app_user := core.require_actor();
BEGIN
  IF NOT core.is_editor(actor) THEN
    RAISE EXCEPTION 'Only editorial users can create claims.' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'New claims must start as draft (got %).', NEW.status USING ERRCODE = '23514';
  END IF;
  NEW.created_by := actor.id;
  NEW.created_at := now();
  NEW.updated_at := now();
  NEW.last_verified_at := NULL;
  NEW.published_at := NULL;
  NEW.retracted_at := NULL;
  RETURN NEW;
END $$;

CREATE FUNCTION core.claim_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor core.app_user := core.require_actor();
  needed text;
  probs text[];
BEGIN
  IF NOT core.is_editor(actor) THEN
    RAISE EXCEPTION 'Only editorial users can change claims.' USING ERRCODE = '42501';
  END IF;

  -- Kind and subject are fixed at creation; records hang off them.
  IF NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.subject_institution_id IS DISTINCT FROM OLD.subject_institution_id
     OR NEW.subject_person_id IS DISTINCT FROM OLD.subject_person_id THEN
    RAISE EXCEPTION 'A claim''s kind and subject cannot change. Create a new claim instead.' USING ERRCODE = '23514';
  END IF;

  -- System-managed columns cannot be written directly.
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  NEW.last_verified_at := OLD.last_verified_at;
  NEW.published_at := OLD.published_at;
  NEW.retracted_at := OLD.retracted_at;
  NEW.updated_at := now();

  -- Content of a verified or published claim is locked.
  IF OLD.status IN ('verified', 'published', 'retracted') AND (
       NEW.claim_text, NEW.claim_category, NEW.is_sensitive, NEW.temporal_scope,
       NEW.known_limitations, NEW.supersedes_claim_id
     ) IS DISTINCT FROM (
       OLD.claim_text, OLD.claim_category, OLD.is_sensitive, OLD.temporal_scope,
       OLD.known_limitations, OLD.supersedes_claim_id) THEN
    RAISE EXCEPTION 'Claim % is %. Move it to needs_reverification before changing its content.',
      OLD.public_id, OLD.status USING ERRCODE = '55000';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  needed := core.transition_role(OLD.status, NEW.status);
  IF needed IS NULL THEN
    RAISE EXCEPTION 'Transition % → % is not permitted.', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  IF needed = 'reviewer' AND NOT core.has_role(actor, 'reviewer')
     OR needed = 'publisher' AND NOT core.has_role(actor, 'publisher') THEN
    RAISE EXCEPTION 'Transition % → % requires the % role.', OLD.status, NEW.status, needed USING ERRCODE = '42501';
  END IF;

  IF NEW.status IN ('verified', 'published') THEN
    IF NOT actor.is_human THEN
      RAISE EXCEPTION 'Automated accounts cannot verify or publish claims.' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'verified' AND actor.id = OLD.created_by THEN
      RAISE EXCEPTION 'A claim must be verified by someone other than its author.' USING ERRCODE = '42501';
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

  IF NEW.status = 'verified' THEN NEW.last_verified_at := now(); NEW.attention_reason := NULL; END IF;
  IF NEW.status = 'published' THEN NEW.published_at := now(); END IF;
  IF NEW.status = 'retracted' THEN NEW.retracted_at := now(); END IF;
  RETURN NEW;
END $$;

-- Every status change writes a review record automatically, so the history is complete
-- even if a status were changed outside the editorial UI.
CREATE FUNCTION core.claim_after_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO core.review (claim_id, reviewer_id, from_status, to_status, notes)
    VALUES (NEW.id, core.current_actor(), OLD.status, NEW.status,
            nullif(current_setting('app.review_notes', true), ''));
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION core.claim_before_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM core.require_actor();
  IF OLD.status <> 'draft' OR EXISTS (SELECT 1 FROM core.review WHERE claim_id = OLD.id) THEN
    RAISE EXCEPTION 'Only never-submitted drafts can be deleted. Retract the claim instead.' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER claim_bi BEFORE INSERT ON core.claim FOR EACH ROW EXECUTE FUNCTION core.claim_before_insert();
CREATE TRIGGER claim_bu BEFORE UPDATE ON core.claim FOR EACH ROW EXECUTE FUNCTION core.claim_before_update();
CREATE TRIGGER claim_au AFTER UPDATE ON core.claim FOR EACH ROW EXECUTE FUNCTION core.claim_after_update();
CREATE TRIGGER claim_bd BEFORE DELETE ON core.claim FOR EACH ROW EXECUTE FUNCTION core.claim_before_delete();

-- Reviews are append-only.
CREATE FUNCTION core.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only.', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;
CREATE TRIGGER review_no_update BEFORE UPDATE OR DELETE ON core.review FOR EACH ROW EXECUTE FUNCTION core.reject_change();
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON core.audit_log FOR EACH ROW EXECUTE FUNCTION core.reject_change();

-- ---------------------------------------------------------------------------
-- Structured records: kind/subject consistency and locking.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.record_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor core.app_user := core.require_actor();
  rec   jsonb;
  c     core.claim;
  expected core.claim_kind := TG_ARGV[0]::core.claim_kind;
  ok    boolean;
BEGIN
  IF NOT core.is_editor(actor) THEN
    RAISE EXCEPTION 'Only editorial users can change records.' USING ERRCODE = '42501';
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT * INTO c FROM core.claim WHERE id = OLD.claim_id;
    IF c.status IN ('verified', 'published', 'retracted') THEN
      RAISE EXCEPTION 'The % record backed by % is locked while the claim is %.', TG_TABLE_NAME, c.public_id, c.status
        USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  END IF;

  rec := to_jsonb(NEW);
  SELECT * INTO c FROM core.claim WHERE id = NEW.claim_id;
  IF c.status IN ('verified', 'published', 'retracted') THEN
    RAISE EXCEPTION 'Cannot attach a % record to % while it is %.', TG_TABLE_NAME, c.public_id, c.status USING ERRCODE = '55000';
  END IF;
  IF c.kind <> expected THEN
    RAISE EXCEPTION 'Claim % is of kind %, not %.', c.public_id, c.kind, expected USING ERRCODE = '23514';
  END IF;

  ok := CASE TG_TABLE_NAME
    WHEN 'position' THEN
      c.subject_person_id = (rec->>'person_id')::int OR c.subject_institution_id = (rec->>'institution_id')::int
    WHEN 'relationship' THEN
      c.subject_person_id IN ((rec->>'source_person_id')::int, (rec->>'target_person_id')::int)
      OR c.subject_institution_id IN ((rec->>'source_institution_id')::int, (rec->>'target_institution_id')::int)
    WHEN 'appointment_process' THEN c.subject_institution_id = (rec->>'institution_id')::int
    WHEN 'appointment_stage' THEN c.subject_institution_id =
      (SELECT institution_id FROM core.appointment_process WHERE id = (rec->>'process_id')::int)
    WHEN 'safeguard' THEN c.subject_institution_id = (rec->>'institution_id')::int
    WHEN 'legal_event' THEN rec->>'institution_id' IS NULL OR c.subject_institution_id = (rec->>'institution_id')::int
    ELSE false
  END;
  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'The claim''s subject must be one of the entities in this % record.', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER position_guard BEFORE INSERT OR UPDATE OR DELETE ON core.position
  FOR EACH ROW EXECUTE FUNCTION core.record_guard('position');
CREATE TRIGGER relationship_guard BEFORE INSERT OR UPDATE OR DELETE ON core.relationship
  FOR EACH ROW EXECUTE FUNCTION core.record_guard('relationship');
CREATE TRIGGER appointment_process_guard BEFORE INSERT OR UPDATE OR DELETE ON core.appointment_process
  FOR EACH ROW EXECUTE FUNCTION core.record_guard('appointment_process');
CREATE TRIGGER appointment_stage_guard BEFORE INSERT OR UPDATE OR DELETE ON core.appointment_stage
  FOR EACH ROW EXECUTE FUNCTION core.record_guard('appointment_stage');
CREATE TRIGGER safeguard_guard BEFORE INSERT OR UPDATE OR DELETE ON core.safeguard
  FOR EACH ROW EXECUTE FUNCTION core.record_guard('safeguard');
CREATE TRIGGER legal_event_guard BEFORE INSERT OR UPDATE OR DELETE ON core.legal_event
  FOR EACH ROW EXECUTE FUNCTION core.record_guard('legal_event');

-- ---------------------------------------------------------------------------
-- Evidence links
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.claim_source_guard() RETURNS trigger
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
    NEW.checked_by := NULL; NEW.checked_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.claim_id <> OLD.claim_id THEN
    RAISE EXCEPTION 'Evidence links cannot be moved between claims.' USING ERRCODE = '23514';
  END IF;

  -- Any change to what the link asserts invalidates a prior human check.
  IF (NEW.source_id, NEW.evidence_role, NEW.relevant_section, NEW.supporting_excerpt, NEW.passage_description)
     IS DISTINCT FROM
     (OLD.source_id, OLD.evidence_role, OLD.relevant_section, OLD.supporting_excerpt, OLD.passage_description) THEN
    NEW.checked_by := NULL; NEW.checked_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.checked_by IS DISTINCT FROM OLD.checked_by AND NEW.checked_by IS NOT NULL THEN
    IF NEW.checked_by <> actor.id OR NOT actor.is_human OR NOT core.has_role(actor, 'reviewer') THEN
      RAISE EXCEPTION 'Only a human reviewer can confirm a source check, and only for themselves.' USING ERRCODE = '42501';
    END IF;
    NEW.checked_at := now();
  ELSIF NEW.checked_by IS NULL THEN
    NEW.checked_at := NULL;
  ELSE
    NEW.checked_at := OLD.checked_at;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER claim_source_guard BEFORE INSERT OR UPDATE OR DELETE ON core.claim_source
  FOR EACH ROW EXECUTE FUNCTION core.claim_source_guard();

-- ---------------------------------------------------------------------------
-- Sources: bibliographic fields lock once they support a verified/published claim.
-- Availability changes raise an attention flag; they never silently hide or delete.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actor core.app_user := core.require_actor();
BEGIN
  IF NOT core.is_editor(actor) THEN
    RAISE EXCEPTION 'Only editorial users can change sources.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := actor.id;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

  NEW.created_by := OLD.created_by;
  NEW.updated_at := now();
  IF (NEW.title, NEW.publisher, NEW.canonical_url, NEW.source_type, NEW.publication_date,
      NEW.publication_precision, NEW.accessed_at, NEW.document_identifier, NEW.document_version)
     IS DISTINCT FROM
     (OLD.title, OLD.publisher, OLD.canonical_url, OLD.source_type, OLD.publication_date,
      OLD.publication_precision, OLD.accessed_at, OLD.document_identifier, OLD.document_version)
     AND EXISTS (SELECT 1 FROM core.claim_source cs JOIN core.claim c ON c.id = cs.claim_id
                 WHERE cs.source_id = OLD.id AND c.status IN ('verified', 'published')) THEN
    RAISE EXCEPTION 'Source % supports a verified or published claim; its bibliographic details are locked. Add a new source record instead.',
      OLD.public_id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION core.source_after_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
BEGIN
  IF NEW.availability IN ('unavailable', 'changed_since_access')
     AND NEW.availability IS DISTINCT FROM OLD.availability THEN
    UPDATE core.claim c SET attention_reason =
      format('Source %s was marked %s on %s. Re-verify; this does not mean the claim is false.',
             NEW.public_id, replace(NEW.availability::text, '_', ' '), current_date)
    WHERE c.id IN (SELECT claim_id FROM core.claim_source WHERE source_id = NEW.id)
      AND c.status IN ('verified', 'published', 'pending_review');
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER source_guard BEFORE INSERT OR UPDATE OR DELETE ON core.source
  FOR EACH ROW EXECUTE FUNCTION core.source_guard();
CREATE TRIGGER source_au AFTER UPDATE ON core.source
  FOR EACH ROW EXECUTE FUNCTION core.source_after_update();

-- ---------------------------------------------------------------------------
-- Entities: identifying fields lock once the identity claim is verified/published.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.entity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor core.app_user := core.require_actor();
  locked boolean;
BEGIN
  IF NOT core.is_editor(actor) THEN
    RAISE EXCEPTION 'Only editorial users can change entities.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1 FROM core.claim c WHERE c.kind = 'identity' AND c.status IN ('verified','published')
      AND CASE TG_TABLE_NAME WHEN 'institution' THEN c.subject_institution_id = OLD.id
                             ELSE c.subject_person_id = OLD.id END) INTO locked;

  IF TG_OP = 'DELETE' THEN
    IF locked THEN RAISE EXCEPTION 'Entity with a verified identity cannot be deleted.' USING ERRCODE = '55000'; END IF;
    RETURN OLD;
  END IF;

  NEW.updated_at := now();
  IF locked AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    RAISE EXCEPTION 'This entity''s identity claim is verified or published; its identifying fields are locked.' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER institution_guard BEFORE INSERT OR UPDATE OR DELETE ON core.institution
  FOR EACH ROW EXECUTE FUNCTION core.entity_guard();
CREATE TRIGGER person_guard BEFORE INSERT OR UPDATE OR DELETE ON core.person
  FOR EACH ROW EXECUTE FUNCTION core.entity_guard();

-- ---------------------------------------------------------------------------
-- Audit log (append-only, written by trigger with definer rights)
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.audit_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
DECLARE prev jsonb; nw jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN prev := to_jsonb(OLD) - 'password_hash'; END IF;
  IF TG_OP <> 'DELETE' THEN nw := to_jsonb(NEW) - 'password_hash'; END IF;
  IF TG_OP = 'UPDATE' AND prev = nw THEN RETURN NULL; END IF;
  INSERT INTO core.audit_log (entity_type, entity_id, action, previous_value, new_value, changed_by, reason)
  VALUES (TG_TABLE_NAME, coalesce(nw->>'id', prev->>'id'), lower(TG_OP), prev, nw,
          core.current_actor(), nullif(current_setting('app.change_reason', true), ''));
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_user','institution','person','claim','position','relationship',
                           'appointment_process','appointment_stage','safeguard','legal_event',
                           'source','claim_source','correction_request'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON core.%I
                    FOR EACH ROW EXECUTE FUNCTION core.audit_trigger()', t || '_audit', t);
  END LOOP;
END $$;
