// Declarative specs for each structured record type. One spec drives the editorial form,
// input parsing, and the INSERT/UPDATE statements, so the three can't drift apart.
import type pg from "pg";
import { int, optStr, parseDated, str, oneOf } from "../lib/validate.js";
import {
  appointmentTypeLabel, eventRelationLabel, legalEventLabel, relationshipLabel, safeguardLabel, RELATIONSHIP_TYPES,
} from "../lib/labels.js";

export type FieldType = "text" | "textarea" | "dated" | "day" | "number" | "enum" | "institution" | "person" | "entity" | "process" | "legal_event";

export interface Field {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hint?: string;
  max?: number;
  options?: Record<string, string>;
  /** dated → [dateCol, precisionCol]; entity → [personCol, institutionCol]; otherwise [col] */
  cols: string[];
}

export interface RecordSpec {
  table: string;
  title: string;
  fields: Field[];
  /** Which parsed value is the claim's subject. */
  subject: (v: Record<string, unknown>, c: pg.PoolClient) => Promise<{ institutionId: number | null; personId: number | null }>;
}

const datedHint = "YYYY, YYYY-MM or YYYY-MM-DD — only as precise as the source. Leave empty if not established.";

export const RECORD_SPECS: Record<string, RecordSpec> = {
  position: {
    table: "position", title: "Position held",
    fields: [
      { name: "person_id", label: "Person", type: "person", required: true, cols: ["person_id"] },
      { name: "institution_id", label: "Institution", type: "institution", required: true, cols: ["institution_id"] },
      { name: "title", label: "Title of the position", type: "text", required: true, max: 200, cols: ["title"], hint: "As written in the source, e.g. Chief Election Commissioner." },
      { name: "start", label: "Start date", type: "dated", cols: ["start_date", "start_precision"], hint: datedHint },
      { name: "end", label: "End date", type: "dated", cols: ["end_date", "end_precision"], hint: datedHint },
      { name: "ongoing_as_of", label: "Confirmed still in office on", type: "day", cols: ["ongoing_as_of"], hint: "Only if a source dated this day confirms the tenure was ongoing. Leave empty if there is an end date." },
      { name: "appointment_type", label: "Manner of appointment", type: "enum", options: appointmentTypeLabel, required: true, cols: ["appointment_type"] },
      { name: "appointing_authority_id", label: "Appointing authority", type: "institution", cols: ["appointing_authority_id"], hint: "Only if the source names it." },
    ],
    subject: async (v) => ({ institutionId: null, personId: v.person_id as number }),
  },
  relationship: {
    table: "relationship", title: "Relationship",
    fields: [
      { name: "source", label: "From", type: "entity", required: true, cols: ["source_person_id", "source_institution_id"] },
      { name: "relationship_type", label: "Relationship type", type: "enum", required: true, options: Object.fromEntries(RELATIONSHIP_TYPES.map((t) => [t, relationshipLabel[t]])), cols: ["relationship_type"] },
      { name: "target", label: "To", type: "entity", required: true, cols: ["target_person_id", "target_institution_id"] },
      { name: "description", label: "Neutral explanation", type: "textarea", required: true, max: 600, cols: ["description"], hint: "What the source establishes, in plain words. No motive or judgement." },
      { name: "valid_from", label: "Valid from", type: "dated", cols: ["valid_from", "valid_from_precision"], hint: datedHint },
      { name: "valid_until", label: "Valid until", type: "dated", cols: ["valid_until", "valid_until_precision"], hint: datedHint },
    ],
    subject: async (v) => {
      const s = v.source as { personId: number | null; institutionId: number | null };
      return { institutionId: s.institutionId, personId: s.personId };
    },
  },
  appointment_process: {
    table: "appointment_process", title: "Appointment process",
    fields: [
      { name: "institution_id", label: "Institution", type: "institution", required: true, cols: ["institution_id"] },
      { name: "office_title", label: "Office", type: "text", required: true, max: 200, cols: ["office_title"], hint: "e.g. Chief Election Commissioner and Election Commissioners" },
      { name: "legal_basis", label: "Legal basis", type: "text", required: true, max: 400, cols: ["legal_basis"], hint: "e.g. Section 7, [Act name]" },
      { name: "process_description", label: "What the law provides", type: "textarea", required: true, max: 2000, cols: ["process_description"] },
      { name: "effective_from", label: "In effect from", type: "dated", cols: ["effective_from", "effective_from_precision"], hint: datedHint },
      { name: "effective_until", label: "In effect until", type: "dated", cols: ["effective_until", "effective_until_precision"], hint: "Leave empty unless a source establishes the end." },
    ],
    subject: async (v) => ({ institutionId: v.institution_id as number, personId: null }),
  },
  appointment_stage: {
    table: "appointment_stage", title: "Appointment stage",
    fields: [
      { name: "process_id", label: "Appointment process", type: "process", required: true, cols: ["process_id"] },
      { name: "seq", label: "Stage number", type: "number", required: true, cols: ["seq"] },
      { name: "stage_title", label: "Stage", type: "text", required: true, max: 160, cols: ["stage_title"], hint: "e.g. Selection Committee recommends" },
      { name: "actor_label", label: "Who acts", type: "text", required: true, max: 300, cols: ["actor_label"], hint: "As defined in the law, e.g. Prime Minister (Chairperson)." },
      { name: "actor_institution_id", label: "Acting body (if it has a profile)", type: "institution", cols: ["actor_institution_id"] },
      { name: "role_description", label: "Formally defined role", type: "textarea", required: true, max: 1200, cols: ["role_description"] },
      { name: "provision_label", label: "Provision", type: "text", max: 160, cols: ["provision_label"], hint: "e.g. Section 7(1)" },
    ],
    subject: async (v, c) => {
      const r = await c.query("SELECT institution_id FROM core.appointment_process WHERE id = $1", [v.process_id]);
      return { institutionId: r.rows[0]?.institution_id ?? null, personId: null };
    },
  },
  safeguard: {
    table: "safeguard", title: "Safeguard",
    fields: [
      { name: "institution_id", label: "Institution", type: "institution", required: true, cols: ["institution_id"] },
      { name: "dimension", label: "Dimension", type: "enum", required: true, options: safeguardLabel, cols: ["dimension"] },
      { name: "provision_label", label: "Provision", type: "text", required: true, max: 160, cols: ["provision_label"], hint: "e.g. Article 324(5)" },
      { name: "establishes", label: "What the provision establishes", type: "textarea", required: true, max: 1500, cols: ["establishes"] },
      { name: "does_not_establish", label: "What it does not establish", type: "textarea", required: true, max: 1500, cols: ["does_not_establish"], hint: "Guard against over-reading the provision." },
      { name: "limitations", label: "Limitations", type: "textarea", max: 1500, cols: ["limitations"] },
    ],
    subject: async (v) => ({ institutionId: v.institution_id as number, personId: null }),
  },
  legal_event: {
    table: "legal_event", title: "Legal or institutional change",
    fields: [
      { name: "institution_id", label: "Institution", type: "institution", required: true, cols: ["institution_id"] },
      { name: "event_type", label: "Type", type: "enum", required: true, options: legalEventLabel, cols: ["event_type"] },
      { name: "title", label: "Title", type: "text", required: true, max: 300, cols: ["title"] },
      { name: "event_date", label: "Date", type: "dated", cols: ["event_date", "event_precision"], hint: datedHint },
      { name: "procedural_status", label: "Procedural status", type: "textarea", max: 600, cols: ["procedural_status"], hint: "e.g. enacted and in force; or judgment later stayed — be specific." },
      { name: "related_event_id", label: "Related event", type: "legal_event", cols: ["related_event_id"] },
      { name: "relation_to_related", label: "Relation to the related event", type: "enum", options: eventRelationLabel, cols: ["relation_to_related"] },
    ],
    subject: async (v) => ({ institutionId: v.institution_id as number, personId: null }),
  },
};

export const FACET_KINDS = ["identity", "mandate", "legal_basis", "composition", "funding", "accountability", "other"] as const;

/** Parses submitted values for a spec. Returns values keyed by field name, or a list of errors. */
export function parseFields(spec: RecordSpec, body: Record<string, unknown>) {
  const errors: string[] = [];
  const values: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const raw = body[f.name];
    let v: unknown = null;
    switch (f.type) {
      case "text": case "textarea": v = optStr(raw, f.max ?? 2000); break;
      case "number": case "institution": case "person": case "process": case "legal_event": v = int(raw); break;
      case "enum": v = oneOf(raw, Object.keys(f.options ?? {})); break;
      case "day": {
        const s = str(raw, 10);
        if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) errors.push(`${f.label}: use YYYY-MM-DD.`);
        v = s || null; break;
      }
      case "dated": {
        const p = parseDated(raw);
        if ("error" in p) errors.push(`${f.label}: ${p.error}`);
        else v = p;
        break;
      }
      case "entity": {
        const s = str(raw, 20);
        const m = s.match(/^([ip]):(\d+)$/);
        v = m ? { personId: m[1] === "p" ? Number(m[2]) : null, institutionId: m[1] === "i" ? Number(m[2]) : null } : null;
        break;
      }
    }
    if (f.required && (v === null || v === "")) errors.push(`${f.label} is required.`);
    values[f.name] = v;
  }
  return { values, errors };
}

function columnsAndValues(spec: RecordSpec, values: Record<string, unknown>) {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const f of spec.fields) {
    const v = values[f.name];
    if (f.type === "dated") {
      const d = (v as { date: string | null; precision: string } | null) ?? { date: null, precision: "unknown" };
      cols.push(f.cols[0]!, f.cols[1]!); vals.push(d.date, d.precision);
    } else if (f.type === "entity") {
      const e = (v as { personId: number | null; institutionId: number | null } | null) ?? { personId: null, institutionId: null };
      cols.push(f.cols[0]!, f.cols[1]!); vals.push(e.personId, e.institutionId);
    } else {
      cols.push(f.cols[0]!); vals.push(v);
    }
  }
  return { cols, vals };
}

export async function insertRecord(c: pg.PoolClient, spec: RecordSpec, claimId: number, values: Record<string, unknown>) {
  const { cols, vals } = columnsAndValues(spec, values);
  const placeholders = vals.map((_, i) => `$${i + 2}`).join(", ");
  // Table and column names come only from the static specs above, never from input.
  await c.query(`INSERT INTO core.${spec.table} (claim_id, ${cols.join(", ")}) VALUES ($1, ${placeholders})`, [claimId, ...vals]);
}

export async function updateRecord(c: pg.PoolClient, spec: RecordSpec, claimId: number, values: Record<string, unknown>) {
  const { cols, vals } = columnsAndValues(spec, values);
  const sets = cols.map((col, i) => `${col} = $${i + 2}`).join(", ");
  await c.query(`UPDATE core.${spec.table} SET ${sets} WHERE claim_id = $1`, [claimId, ...vals]);
}

/** Reverse of parse: current DB row → form values (dates back to their entered precision). */
export function rowToForm(spec: RecordSpec, row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of spec.fields) {
    if (f.type === "dated") {
      const d = row[f.cols[0]!] as string | null; const p = row[f.cols[1]!] as string;
      out[f.name] = !d ? "" : p === "year" ? d.slice(0, 4) : p === "month" ? d.slice(0, 7) : d;
    } else if (f.type === "entity") {
      const pid = row[f.cols[0]!]; const iid = row[f.cols[1]!];
      out[f.name] = pid ? `p:${pid}` : iid ? `i:${iid}` : "";
    } else {
      const v = row[f.cols[0]!];
      out[f.name] = v === null || v === undefined ? "" : String(v);
    }
  }
  return out;
}
