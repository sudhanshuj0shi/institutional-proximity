// Human-readable labels and neutral explanations. These strings are the product's
// controlled vocabulary: they describe a documented structure, never a motive.

export const RELATIONSHIP_TYPES = [
  "appointed_by", "nominated_by", "selected_through", "previously_held_position_at",
  "served_as_member_of", "formally_reports_to", "has_statutory_responsibility_for",
  "has_jurisdiction_over", "participates_in_appointment_of", "subsequently_appointed_to",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const relationshipLabel: Record<RelationshipType, string> = {
  appointed_by: "Appointed by",
  nominated_by: "Nominated by",
  selected_through: "Selected through",
  previously_held_position_at: "Previously held a position at",
  served_as_member_of: "Served as a member of",
  formally_reports_to: "Formally reports to",
  has_statutory_responsibility_for: "Has statutory responsibility for",
  has_jurisdiction_over: "Has jurisdiction over",
  participates_in_appointment_of: "Participates in the appointment process of",
  subsequently_appointed_to: "Subsequently appointed to",
};

export const relationshipMeaning: Record<RelationshipType, string> = {
  appointed_by: "A source identifies the second party as the authority that made the appointment. This is a documented appointment relationship and does not, by itself, establish political influence.",
  nominated_by: "A source records that the second party nominated the first. Nomination is distinct from appointment.",
  selected_through: "A source records that the selection was made through the named process or body.",
  previously_held_position_at: "A source records an earlier position. Earlier employment does not establish an ongoing connection.",
  served_as_member_of: "A source records membership of the named body for the period shown.",
  formally_reports_to: "A legal or official source establishes a formal reporting line. It describes structure, not conduct.",
  has_statutory_responsibility_for: "A statute assigns this responsibility. It describes the legal design, not how the responsibility is exercised.",
  has_jurisdiction_over: "A legal source establishes jurisdiction over the named body or matter.",
  participates_in_appointment_of: "A legal source gives this party a defined role in the selection or appointment process.",
  subsequently_appointed_to: "A source records a later appointment. A later appointment is not evidence of a reward or arrangement.",
};

// Distinct visual encodings (line style), so meaning never depends on colour alone.
export const relationshipStroke: Record<RelationshipType | "held_position" | "appointing_authority", string> = {
  appointed_by: "solid",
  appointing_authority: "solid",
  nominated_by: "dash",
  selected_through: "dashdot",
  previously_held_position_at: "dot",
  served_as_member_of: "dot",
  held_position: "double",
  formally_reports_to: "longdash",
  has_statutory_responsibility_for: "longdash",
  has_jurisdiction_over: "longdash",
  participates_in_appointment_of: "dashdot",
  subsequently_appointed_to: "dot",
};

export const legalCategoryLabel: Record<string, string> = {
  constitutional_body: "Constitutional body",
  statutory_body: "Statutory body",
  executive_body: "Executive body",
  constitutional_office: "Constitutional office",
  parliamentary_body: "Parliamentary body",
  judicial_body: "Judicial body",
  other: "Other",
};

export const entityKindLabel: Record<string, string> = {
  independent_institution: "Independent institution",
  government_body: "Government body",
  selection_body: "Selection body",
  legislature: "Legislature",
  court: "Court",
};

export const categoryLabel: Record<string, string> = {
  verified_fact: "Verified fact",
  official_finding: "Official finding",
  reported_allegation: "Reported allegation",
  analytical_interpretation: "Analytical interpretation",
  unknown: "Unknown",
};

export const categoryMeaning: Record<string, string> = {
  verified_fact: "Directly supported by a reliable source.",
  official_finding: "A finding made by an identifiable court, tribunal, regulator or other competent body, described within its scope.",
  reported_allegation: "Reported by a source but not established as true. Not published in this version.",
  analytical_interpretation: "An interpretation derived from documented facts using a published method. Not published in this version.",
  unknown: "Information that cannot currently be established.",
};

export const statusLabel: Record<string, string> = {
  draft: "Draft",
  researching: "Researching",
  pending_review: "Pending review",
  verified: "Verified, not yet published",
  published: "Published",
  needs_reverification: "Needs re-verification",
  disputed: "Disputed",
  retracted: "Retracted",
};

export const kindLabel: Record<string, string> = {
  identity: "Identity",
  mandate: "Mandate",
  legal_basis: "Legal basis",
  funding: "Funding arrangements",
  accountability: "Reporting and accountability",
  composition: "Composition",
  position: "Position held",
  relationship: "Relationship",
  appointment_process: "Appointment process",
  appointment_stage: "Appointment stage",
  safeguard: "Safeguard",
  legal_event: "Legal or institutional change",
  other: "Other",
};

export const appointmentTypeLabel: Record<string, string> = {
  appointed: "Appointed",
  nominated: "Nominated",
  elected: "Elected",
  ex_officio: "Ex officio",
  additional_charge: "Additional charge",
  acting: "Acting",
  unknown: "Manner of appointment not established",
};

export const safeguardLabel: Record<string, string> = {
  appointment: "Appointment",
  tenure: "Tenure",
  removal: "Removal",
  conditions_of_service: "Conditions of service",
  financial: "Financial arrangements",
  operational_autonomy: "Operational autonomy",
  transparency: "Transparency obligations",
  accountability: "Accountability mechanisms",
};

export const legalEventLabel: Record<string, string> = {
  constitutional_provision: "Constitutional provision",
  constitutional_amendment: "Constitutional amendment",
  bill_introduced: "Bill introduced (proposed, not law)",
  bill_passed: "Bill passed by Parliament",
  act_enacted: "Act enacted",
  act_commenced: "Act brought into force",
  amendment_enacted: "Amending Act enacted",
  rules_notified: "Rules notified",
  notification: "Official notification",
  judgment: "Judgment",
  interim_order: "Interim order",
  appeal_filed: "Appeal filed",
  stay: "Stay",
  review: "Review",
  other: "Other",
};

export const eventRelationLabel: Record<string, string> = {
  appeal_of: "Appeal against",
  stay_of: "Stays",
  review_of: "Review of",
  amends: "Amends",
  supersedes: "Supersedes",
  implements: "Implements",
  responds_to: "Responds to",
};

export const sourceTypeLabel: Record<string, string> = {
  constitution: "Constitution of India",
  legislation: "Legislation",
  gazette_notification: "Gazette notification",
  judgment: "Court judgment",
  official_website: "Official website",
  appointment_notification: "Appointment notification",
  parliamentary_record: "Parliamentary record",
  committee_report: "Committee report",
  government_publication: "Government publication",
  institutional_report: "Institutional report",
  news_report: "News report",
  peer_reviewed: "Peer-reviewed research",
  academic: "Academic publication",
  legal_research: "Legal research publication",
  civil_society: "Civil society research",
  discovery_other: "Discovery source",
};

export const tierLabel: Record<number, string> = {
  1: "Primary source",
  2: "Reputable secondary source",
  3: "Discovery source (cannot establish a claim)",
};

export function label(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return "";
  return map[key] ?? key.replace(/_/g, " ");
}
