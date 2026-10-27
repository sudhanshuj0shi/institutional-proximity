// Builds the relationship-map dataset from public records. Pure function: it only
// re-shapes records it is given and never derives an edge that has no backing record.
import type { Institution, Person, Position, Relationship } from "./queries.js";
import type { Precision } from "../lib/dates.js";
import { formatRange } from "../lib/dates.js";
import { relationshipLabel, relationshipMeaning, type RelationshipType } from "../lib/labels.js";

export interface GraphNode {
  id: string;              // "i:<slug>" or "p:<slug>"
  kind: string;            // person | independent_institution | government_body | ...
  label: string;
  href: string;
}
export interface GraphEdge {
  id: string;
  type: RelationshipType | "held_position";
  label: string;
  source: string;
  target: string;
  claimId: string;
  description: string;
  meaning: string;
  period: string;
  historical: boolean;
  from: string | null;
  until: string | null;
  basis: "relationship" | "position" | "position_appointing_authority";
  /** Who checked the backing claim: "ai" is labelled publicly. */
  checkedBy: "human" | "ai" | null;
}
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; generatedAt: string; }

const key = (type: "person" | "institution", slug: string) => (type === "person" ? `p:${slug}` : `i:${slug}`);

function isPast(until: string | null, precision: Precision, today: string) {
  return !!until && precision !== "unknown" && until < today;
}

export function buildGraph(
  input: { institutions: Institution[]; people: Person[]; positions: Position[]; relationships: Relationship[]; checkedBy?: Map<string, "human" | "ai" | null> },
  today = new Date().toISOString().slice(0, 10),
): GraphData {
  const nodes = new Map<string, GraphNode>();
  for (const i of input.institutions) {
    nodes.set(key("institution", i.slug), { id: key("institution", i.slug), kind: i.entity_kind, label: i.short_name ?? i.canonical_name, href: `/institutions/${i.slug}` });
  }
  for (const p of input.people) {
    nodes.set(key("person", p.slug), { id: key("person", p.slug), kind: "person", label: p.canonical_name, href: `/people/${p.slug}` });
  }

  const edges: GraphEdge[] = [];
  const cb = (id: string) => input.checkedBy?.get(id) ?? null;
  for (const r of input.relationships) {
    const s = key(r.source_type, r.source_slug);
    const t = key(r.target_type, r.target_slug);
    if (!nodes.has(s) || !nodes.has(t)) continue; // never draw an edge to an entity that is not public
    const type = r.relationship_type as RelationshipType;
    edges.push({
      id: `r${r.id}`, type, label: relationshipLabel[type] ?? type, source: s, target: t, claimId: r.claim_id,
      description: r.description, meaning: relationshipMeaning[type] ?? "",
      period: formatRange(r.valid_from, r.valid_from_precision, r.valid_until, r.valid_until_precision),
      historical: isPast(r.valid_until, r.valid_until_precision, today),
      from: r.valid_from, until: r.valid_until, basis: "relationship", checkedBy: cb(r.claim_id),
    });
  }
  for (const p of input.positions) {
    const s = key("person", p.person_slug);
    const t = key("institution", p.institution_slug);
    if (!nodes.has(s) || !nodes.has(t)) continue;
    const period = formatRange(p.start_date, p.start_precision, p.end_date, p.end_precision, p.ongoing_as_of);
    const historical = isPast(p.end_date, p.end_precision, today);
    edges.push({
      id: `p${p.id}`, type: "held_position", label: "Held position at", source: s, target: t, claimId: p.claim_id,
      description: `${p.person_name} held the position of ${p.title} at ${p.institution_name}.`,
      meaning: "A source records that this person held this position for the period shown.",
      period, historical, from: p.start_date, until: p.end_date, basis: "position", checkedBy: cb(p.claim_id),
    });
    if (p.appointing_authority_slug) {
      const a = key("institution", p.appointing_authority_slug);
      if (nodes.has(a)) {
        edges.push({
          id: `pa${p.id}`, type: "appointed_by", label: relationshipLabel.appointed_by, source: s, target: a, claimId: p.claim_id,
          description: `The record of ${p.person_name}'s appointment as ${p.title} identifies ${p.appointing_authority_name} as the appointing authority.`,
          meaning: relationshipMeaning.appointed_by, period, historical, from: p.start_date, until: p.end_date,
          basis: "position_appointing_authority", checkedBy: cb(p.claim_id),
        });
      }
    }
  }
  return { nodes: [...nodes.values()], edges, generatedAt: new Date().toISOString() };
}
