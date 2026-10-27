// Shapes published records into compact datasets for the interactive visuals.
// Only re-shapes public records; every item carries its claim ID and who checked it.
import * as Q from "./queries.js";
import {
  entityKindLabel, legalCategoryLabel, legalEventLabel, relationshipLabel, safeguardLabel, type RelationshipType,
} from "../lib/labels.js";

export const SAFEGUARD_ORDER = ["appointment", "tenure", "removal", "conditions_of_service", "financial",
  "operational_autonomy", "transparency", "accountability"] as const;

export interface VizInstitution { slug: string; name: string; short: string; kind: string; kindLabel: string; category: string; }
export interface VizLink { id: string; source: string; target: string; type: string; label: string; description: string; claimId: string; ai: boolean; }
export interface VizSafeguard { institution: string; dimension: string; dimensionLabel: string; provision: string; establishes: string; doesNot: string; claimId: string; ai: boolean; }
export interface VizEvent { institution: string | null; type: string; typeLabel: string; title: string; date: string | null; precision: string; status: string | null; claimId: string; ai: boolean; }
export interface VizTenure { person: string; personSlug: string; institution: string; title: string; start: string | null; startP: string; end: string | null; endP: string; claimId: string; ai: boolean; }
export interface VizStage { institution: string; process: string; seq: number; title: string; actor: string; actorSlug: string | null; role: string; provision: string | null; claimId: string; ai: boolean; }
export interface VizData {
  institutions: VizInstitution[]; links: VizLink[]; safeguards: VizSafeguard[]; events: VizEvent[];
  tenures: VizTenure[]; stages: VizStage[]; dimensions: { key: string; label: string }[]; today: string;
}

export async function loadVizData(): Promise<VizData> {
  const [insts, rels, sgs, evs, poss, procs, stages] = await Promise.all([
    Q.listInstitutions(), Q.allRelationships(), Q.allSafeguards(), Q.allLegalEvents(), Q.allPositions(), Q.allProcesses(), Q.allStages(),
  ]);
  const ids = [...rels.map((r) => r.claim_id), ...sgs.map((s) => s.claim_id), ...evs.map((e) => e.claim_id),
    ...poss.map((p) => p.claim_id), ...stages.map((s) => s.claim_id)];
  const basis = await Q.basisFor(ids);
  const ai = (id: string) => basis.get(id) === "ai";
  const procBy = new Map(procs.map((p) => [p.id, p]));
  return {
    institutions: insts.map((i) => ({
      slug: i.slug, name: i.canonical_name, short: i.short_name ?? i.canonical_name, kind: i.entity_kind,
      kindLabel: entityKindLabel[i.entity_kind] ?? i.entity_kind, category: legalCategoryLabel[i.legal_category] ?? i.legal_category,
    })),
    links: rels.filter((r) => r.source_type === "institution" && r.target_type === "institution").map((r) => ({
      id: `r${r.id}`, source: r.source_slug, target: r.target_slug, type: r.relationship_type,
      label: relationshipLabel[r.relationship_type as RelationshipType] ?? r.relationship_type,
      description: r.description, claimId: r.claim_id, ai: ai(r.claim_id),
    })),
    safeguards: sgs.map((s) => ({
      institution: s.institution_slug, dimension: s.dimension, dimensionLabel: safeguardLabel[s.dimension] ?? s.dimension,
      provision: s.provision_label, establishes: s.establishes, doesNot: s.does_not_establish, claimId: s.claim_id, ai: ai(s.claim_id),
    })),
    events: evs.map((e) => ({
      institution: e.institution_slug, type: e.event_type, typeLabel: legalEventLabel[e.event_type] ?? e.event_type,
      title: e.title, date: e.event_date, precision: e.event_precision, status: e.procedural_status, claimId: e.claim_id, ai: ai(e.claim_id),
    })),
    tenures: poss.map((p) => ({
      person: p.person_name, personSlug: p.person_slug, institution: p.institution_slug, title: p.title,
      start: p.start_date, startP: p.start_precision, end: p.end_date, endP: p.end_precision, claimId: p.claim_id, ai: ai(p.claim_id),
    })),
    stages: stages.map((s) => {
      const p = procBy.get(s.process_id);
      return { institution: p?.institution_slug ?? "", process: p?.office_title ?? "", seq: s.seq, title: s.stage_title,
        actor: s.actor_label, actorSlug: s.actor_institution_slug, role: s.role_description, provision: s.provision_label,
        claimId: s.claim_id, ai: ai(s.claim_id) };
    }),
    dimensions: SAFEGUARD_ORDER.map((k) => ({ key: k, label: safeguardLabel[k] ?? k })),
    today: new Date().toISOString().slice(0, 10),
  };
}
