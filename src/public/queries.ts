// Public read layer. Uses ONLY the ip_public pool, which can only see public_api views.
// Even if a route here had a bug, it could not return unpublished data.
import { getPublicPool } from "../db/pool.js";
import type { Precision } from "../lib/dates.js";

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPublicPool().query(sql, params)).rows as T[];
}

export interface Institution {
  id: number; slug: string; canonical_name: string; short_name: string | null; entity_kind: string;
  legal_category: string; official_website: string | null; last_verified_at: Date | null; published_claim_count: string;
}
export interface Person { id: number; slug: string; canonical_name: string; last_verified_at: Date | null; }
export interface Claim {
  public_id: string; kind: string; claim_text: string; claim_category: string; temporal_scope: string | null;
  known_limitations: string | null; last_verified_at: Date | null; published_at: Date | null;
  institution_slug: string | null; institution_name: string | null; person_slug: string | null; person_name: string | null;
  corrects_claim_id: string | null; verification_basis: "human" | "ai" | null;
}
export interface Evidence {
  claim_id: string; evidence_role: string; relevant_section: string | null; supporting_excerpt: string | null;
  passage_description: string | null; confirmed_on: string | null; source_id: string; title: string; publisher: string;
  canonical_url: string; source_type: string; tier: number; publication_date: string | null;
  publication_precision: Precision; accessed_at: string | null; document_identifier: string | null;
  document_version: string | null; archived_url: string | null; availability: string; check_basis: "human" | "ai" | null;
}
export interface Position {
  id: number; claim_id: string; person_id: number; person_slug: string; person_name: string;
  institution_id: number; institution_slug: string; institution_name: string; institution_kind: string;
  title: string; start_date: string | null; start_precision: Precision; end_date: string | null; end_precision: Precision;
  ongoing_as_of: string | null; appointment_type: string;
  appointing_authority_id: number | null; appointing_authority_slug: string | null; appointing_authority_name: string | null;
}
export interface Relationship {
  id: number; claim_id: string; relationship_type: string; description: string;
  source_type: "person" | "institution"; source_id: number; source_slug: string; source_name: string;
  target_type: "person" | "institution"; target_id: number; target_slug: string; target_name: string;
  valid_from: string | null; valid_from_precision: Precision; valid_until: string | null; valid_until_precision: Precision;
}
export interface AppointmentProcess {
  id: number; claim_id: string; institution_slug: string; office_title: string; legal_basis: string;
  process_description: string; effective_from: string | null; effective_from_precision: Precision;
  effective_until: string | null; effective_until_precision: Precision;
}
export interface AppointmentStage {
  id: number; claim_id: string; process_id: number; seq: number; stage_title: string; actor_label: string;
  role_description: string; provision_label: string | null;
  actor_institution_id: number | null; actor_institution_slug: string | null; actor_institution_name: string | null;
}
export interface Safeguard {
  id: number; claim_id: string; institution_slug: string; dimension: string; provision_label: string;
  establishes: string; does_not_establish: string; limitations: string | null; last_verified_at: Date | null;
}
export interface LegalEvent {
  id: number; claim_id: string; institution_slug: string | null; institution_name: string | null; event_type: string;
  title: string; event_date: string | null; event_precision: Precision; procedural_status: string | null;
  related_event_id: number | null; relation_to_related: string | null; published_at: Date | null;
}
export interface Withdrawal {
  claim_id: string; kind: string; withdrawal_type: "withdrawn" | "temporarily_withdrawn";
  institution_name: string | null; person_name: string | null; public_correction_note: string | null;
  withdrawn_at: Date; replaced_by_claim_id: string | null;
}
export interface SiteStatus { published_claims: string; awaiting_review: string; in_research: string; published_ai_checked: string; }

export const siteStatus = async () => (await q<SiteStatus>("SELECT * FROM public_api.site_status"))[0]!;

export function listInstitutions(opts: { q?: string; category?: string; kind?: string } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.q) { params.push(`%${opts.q}%`); where.push(`(canonical_name ILIKE $${params.length} OR short_name ILIKE $${params.length})`); }
  if (opts.category) { params.push(opts.category); where.push(`legal_category::text = $${params.length}`); }
  if (opts.kind) { params.push(opts.kind); where.push(`entity_kind::text = $${params.length}`); }
  return q<Institution>(
    `SELECT * FROM public_api.institutions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY canonical_name`, params);
}
export const getInstitution = async (slug: string) =>
  (await q<Institution>("SELECT * FROM public_api.institutions WHERE slug = $1", [slug]))[0];
export const getPerson = async (slug: string) =>
  (await q<Person>("SELECT * FROM public_api.people WHERE slug = $1", [slug]))[0];
export const listPeople = () => q<Person>("SELECT * FROM public_api.people ORDER BY canonical_name");

export const claimsForInstitution = (slug: string) =>
  q<Claim>("SELECT * FROM public_api.claims WHERE institution_slug = $1 ORDER BY published_at", [slug]);
export const claimsForPerson = (slug: string) =>
  q<Claim>("SELECT * FROM public_api.claims WHERE person_slug = $1 ORDER BY published_at", [slug]);
export const getClaim = async (id: string) =>
  (await q<Claim>("SELECT * FROM public_api.claims WHERE public_id = $1", [id]))[0];
export const getWithdrawal = async (id: string) =>
  (await q<Withdrawal>("SELECT * FROM public_api.withdrawals WHERE claim_id = $1", [id]))[0];
export const listWithdrawals = () => q<Withdrawal>("SELECT * FROM public_api.withdrawals ORDER BY withdrawn_at DESC");

export function evidenceFor(claimIds: string[]) {
  if (claimIds.length === 0) return Promise.resolve([] as Evidence[]);
  return q<Evidence>(
    "SELECT * FROM public_api.claim_evidence WHERE claim_id = ANY($1) ORDER BY claim_id, evidence_role, source_id", [claimIds]);
}

export const positionsForInstitution = (id: number) =>
  q<Position>("SELECT * FROM public_api.positions WHERE institution_id = $1 ORDER BY start_date NULLS LAST", [id]);
export const positionsForPerson = (id: number) =>
  q<Position>("SELECT * FROM public_api.positions WHERE person_id = $1 ORDER BY start_date NULLS LAST", [id]);
export const allPositions = () => q<Position>("SELECT * FROM public_api.positions");

export const relationshipsFor = (type: "person" | "institution", id: number) =>
  q<Relationship>(
    `SELECT * FROM public_api.relationships
     WHERE (source_type = $1 AND source_id = $2) OR (target_type = $1 AND target_id = $2)
     ORDER BY valid_from NULLS LAST`, [type, id]);
export const allRelationships = () => q<Relationship>("SELECT * FROM public_api.relationships");

export const processesFor = (slug: string) =>
  q<AppointmentProcess>(
    "SELECT * FROM public_api.appointment_processes WHERE institution_slug = $1 ORDER BY effective_from DESC NULLS LAST", [slug]);
export function stagesFor(processIds: number[]) {
  if (processIds.length === 0) return Promise.resolve([] as AppointmentStage[]);
  return q<AppointmentStage>("SELECT * FROM public_api.appointment_stages WHERE process_id = ANY($1) ORDER BY process_id, seq", [processIds]);
}
export const safeguardsFor = (slug: string) =>
  q<Safeguard>("SELECT * FROM public_api.safeguards WHERE institution_slug = $1 ORDER BY dimension, id", [slug]);
export const legalEventsFor = (slug: string) =>
  q<LegalEvent>("SELECT * FROM public_api.legal_events WHERE institution_slug = $1 ORDER BY event_date NULLS LAST, id", [slug]);
export const recentLegalEvents = (days: number) =>
  q<LegalEvent>(
    `SELECT * FROM public_api.legal_events
     WHERE event_date IS NOT NULL AND event_date >= current_date - $1::int
     ORDER BY event_date DESC LIMIT 6`, [days]);

export const coverageFor = async (slug: string) =>
  (await q<{ published: string; in_progress: string }>("SELECT published, in_progress FROM public_api.coverage WHERE slug = $1", [slug]))[0];
export const allCoverage = () => q<{ slug: string; published: string; in_progress: string }>("SELECT * FROM public_api.coverage");
export const allProcesses = () => q<AppointmentProcess>("SELECT * FROM public_api.appointment_processes");
/** Who checked each published claim: a person ("human") or an automated reviewer ("ai"). */
export async function basisFor(claimIds: string[]): Promise<Map<string, "human" | "ai" | null>> {
  if (claimIds.length === 0) return new Map();
  const rows = await q<{ public_id: string; verification_basis: "human" | "ai" | null }>(
    "SELECT public_id, verification_basis FROM public_api.claims WHERE public_id = ANY($1)", [claimIds]);
  return new Map(rows.map((r) => [r.public_id, r.verification_basis]));
}
export const mandateClaims = () => q<Claim>("SELECT * FROM public_api.claims WHERE kind = 'mandate'");

export async function submitCorrection(input: { claimId: string | null; pagePath: string | null; message: string; name: string | null; contact: string | null }) {
  const r = await getPublicPool().query("SELECT public_api.submit_correction($1, $2, $3, $4, $5) AS ref",
    [input.claimId, input.pagePath, input.message, input.name, input.contact]);
  return r.rows[0].ref as string;
}
