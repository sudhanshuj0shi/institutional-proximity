// Imports researched candidate claims as `pending_review` under a NON-HUMAN account.
// Every database rule applies: the import account cannot verify or publish, and no
// evidence link is marked as checked. Re-running is a no-op once imported.
import pg from "pg";
import { fileURLToPath } from "node:url";
import { AI_REVIEW, CLAIMS, INSTITUTIONS, PEOPLE, SOURCES } from "./candidates.js";

const IMPORT_USER = "research-import";

export async function seedCandidates(ownerUrl: string, log = false) {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query("BEGIN");
    let uid = (await c.query("SELECT id FROM core.app_user WHERE username = $1", [IMPORT_USER])).rows[0]?.id as number | undefined;
    if (!uid) {
      uid = (await c.query(
        `INSERT INTO core.app_user (username, display_name, public_role_label, roles, is_human)
         VALUES ($1, 'Research import (AI-assisted)', 'Automated research import', '{researcher}', false) RETURNING id`, [IMPORT_USER])).rows[0].id;
    }
    if ((await c.query("SELECT 1 FROM core.claim WHERE created_by = $1 LIMIT 1", [uid])).rowCount) {
      await c.query("ROLLBACK");
      if (log) console.log("Candidate claims already imported; nothing to do.");
      return { imported: 0 };
    }
    await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.change_reason', 'candidate import (AI-assisted research, unverified)', true), set_config('app.review_notes', 'Imported by an automated account. Requires independent human verification of every source.', true)", [String(uid)]);

    const inst = new Map<string, number>();
    for (const i of INSTITUTIONS) {
      const existing = (await c.query("SELECT id FROM core.institution WHERE slug = $1", [i.slug])).rows[0]?.id;
      inst.set(i.key, existing ?? (await c.query(
        "INSERT INTO core.institution (slug, canonical_name, short_name, entity_kind, legal_category, official_website) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [i.slug, i.name, i.short, i.kind, i.category, i.site])).rows[0].id);
    }
    const people = new Map<string, number>();
    for (const p of PEOPLE) {
      const existing = (await c.query("SELECT id FROM core.person WHERE slug = $1", [p.slug])).rows[0]?.id;
      people.set(p.key, existing ?? (await c.query("INSERT INTO core.person (slug, canonical_name) VALUES ($1,$2) RETURNING id", [p.slug, p.name])).rows[0].id);
    }
    const sources = new Map<string, number>();
    for (const s of SOURCES) {
      sources.set(s.key, (await c.query(
        `INSERT INTO core.source (title, publisher, canonical_url, source_type, publication_date, publication_precision, accessed_at,
           document_identifier, document_version, availability, source_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [s.title, s.publisher, s.url, s.type, s.pub?.date ?? null, s.pub?.precision ?? "unknown", s.accessed,
          s.docid ?? null, s.version ?? null, s.accessed ? "available" : "unknown", s.notes])).rows[0].id);
    }

    const processByClaim = new Map<string, number>();
    const resolve = (v: unknown): unknown => {
      if (typeof v !== "string" || !v.startsWith("@")) return v;
      const [kind, key] = v.slice(1).split(":") as [string, string];
      const map = kind === "i" ? inst : kind === "p" ? people : kind === "process" ? processByClaim : null;
      const id = map?.get(key);
      if (id === undefined) throw new Error(`Unresolved reference ${v}`);
      return id;
    };

    const missing = CLAIMS.filter((cl) => !AI_REVIEW[cl.key]).map((cl) => cl.key);
    if (missing.length) throw new Error(`No AI review note for: ${missing.join(", ")}`);
    let n = 0;
    for (const cl of CLAIMS) {
      const claimId = (await c.query(
        `INSERT INTO core.claim (kind, claim_text, claim_category, subject_institution_id, subject_person_id, temporal_scope, is_sensitive, known_limitations, review_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [cl.kind, cl.text, cl.category ?? "verified_fact", cl.subject.inst ? inst.get(cl.subject.inst) : null,
          cl.subject.person ? people.get(cl.subject.person) : null, cl.temporal ?? null, cl.sensitive ?? false, cl.limitations ?? null,
          ["AI-assisted candidate. Every excerpt and description must be confirmed against the original source by a human reviewer.", cl.notes, AI_REVIEW[cl.key] ? `AI review 27 Oct 2026: ${AI_REVIEW[cl.key]}` : null].filter(Boolean).join("\n\n")])).rows[0].id as number;

      if (cl.record) {
        const cols: string[] = []; const vals: unknown[] = [];
        for (const [k, v] of Object.entries(cl.record.values)) {
          if (k === "source" || k === "target") {
            const s = String(v); const id = resolve(s);
            cols.push(`${k}_person_id`, `${k}_institution_id`);
            vals.push(s.startsWith("@p:") ? id : null, s.startsWith("@i:") ? id : null);
          } else { cols.push(k); vals.push(resolve(v)); }
        }
        const ph = vals.map((_, i) => `$${i + 2}`).join(", ");
        const row = (await c.query(`INSERT INTO core.${cl.record.table} (claim_id, ${cols.join(", ")}) VALUES ($1, ${ph}) RETURNING id`, [claimId, ...vals])).rows[0];
        if (cl.record.table === "appointment_process") processByClaim.set(cl.key, row.id);
      }
      for (const e of cl.evidence) {
        const sid = sources.get(e.src);
        if (!sid) throw new Error(`Unknown source ${e.src} in ${cl.key}`);
        await c.query(
          `INSERT INTO core.claim_source (claim_id, source_id, evidence_role, relevant_section, supporting_excerpt, passage_description, verification_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [claimId, sid, e.role ?? "supports", e.section, e.excerpt ?? null, e.description ?? null, e.notes ?? null]);
      }
      await c.query("UPDATE core.claim SET status = 'pending_review' WHERE id = $1", [claimId]);
      n++;
    }
    await c.query("COMMIT");
    if (log) console.log(`Imported ${n} candidate claims, ${SOURCES.length} sources, ${INSTITUTIONS.length} institutions and ${PEOPLE.length} people. All are pending human review; none is published.`);
    return { imported: n };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { config } = await import("../config.js");
  await seedCandidates(config.ownerUrl, true);
}
