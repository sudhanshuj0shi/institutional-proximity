// Test fixtures. All names here are deliberately fictional placeholders ("Test …") and
// exist only inside the throwaway test database — never in the application database.
import pg from "pg";
import { randomBytes } from "node:crypto";

export const uid = () => randomBytes(4).toString("hex");

export function ownerClient() {
  return new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
}

/** Run as the real ip_editor role with an app actor set, like the application does. */
export async function asUser<T>(userId: number, fn: (c: pg.Client) => Promise<T>, notes = ""): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_EDITOR });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.review_notes', $2, true)", [String(userId), notes]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

export async function publicQuery(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_PUBLIC });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

export interface Team { researcher: number; reviewer: number; publisher: number; reviewer2: number; bot: number; ai: number; }

export async function makeTeam(): Promise<Team> {
  const o = ownerClient();
  await o.connect();
  const id = uid();
  const mk = async (name: string, roles: string[], human = true) =>
    (await o.query(
      "INSERT INTO core.app_user (username, display_name, roles, is_human) VALUES ($1, $2, $3::core.user_role[], $4) RETURNING id",
      [`${name}_${id}`, `Test ${name}`, roles, human],
    )).rows[0].id as number;
  const team = {
    researcher: await mk("researcher", ["researcher"]),
    reviewer: await mk("reviewer", ["reviewer"]),
    reviewer2: await mk("reviewer2", ["reviewer", "researcher"]),
    publisher: await mk("publisher", ["publisher"]),
    bot: await mk("bot", ["researcher"], false),
    ai: await mk("ai", ["researcher", "ai_reviewer"], false),
  };
  await o.end();
  return team;
}

export async function createInstitution(userId: number, name = `Test Institution ${uid()}`) {
  return asUser(userId, async (c) => (await c.query(
    `INSERT INTO core.institution (slug, canonical_name, entity_kind, legal_category)
     VALUES ($1, $2, 'independent_institution', 'statutory_body') RETURNING id`,
    [`test-${uid()}`, name])).rows[0].id as number);
}

export async function createPerson(userId: number) {
  return asUser(userId, async (c) => (await c.query(
    `INSERT INTO core.person (slug, canonical_name) VALUES ($1, $2) RETURNING id`,
    [`test-person-${uid()}`, `Test Person ${uid()}`])).rows[0].id as number);
}

export async function createClaim(userId: number, opts: {
  kind?: string; institutionId?: number; personId?: number; category?: string; sensitive?: boolean; text?: string;
}) {
  return asUser(userId, async (c) => (await c.query(
    `INSERT INTO core.claim (kind, claim_text, claim_category, subject_institution_id, subject_person_id, is_sensitive)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, public_id`,
    [opts.kind ?? "identity", opts.text ?? "Test claim text for fixture purposes.", opts.category ?? "verified_fact",
     opts.institutionId ?? null, opts.personId ?? null, opts.sensitive ?? false])).rows[0] as { id: number; public_id: string });
}

export async function createSource(userId: number, opts: { type?: string; accessed?: string | null; url?: string } = {}) {
  return asUser(userId, async (c) => (await c.query(
    `INSERT INTO core.source (title, publisher, canonical_url, source_type, accessed_at)
     VALUES ('Test Source', 'Test Publisher', $1, $2, $3) RETURNING id`,
    [opts.url ?? `https://example.org/doc-${uid()}`, opts.type ?? "legislation",
     opts.accessed === undefined ? "2026-10-01" : opts.accessed])).rows[0].id as number);
}

export async function linkSource(userId: number, claimId: number, sourceId: number, opts: { role?: string; section?: string | null; excerpt?: string | null } = {}) {
  return asUser(userId, async (c) => (await c.query(
    `INSERT INTO core.claim_source (claim_id, source_id, evidence_role, relevant_section, supporting_excerpt)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [claimId, sourceId, opts.role ?? "supports", opts.section === undefined ? "Section 1" : opts.section,
     opts.excerpt === undefined ? "Test excerpt." : opts.excerpt])).rows[0].id as number);
}

export async function confirmLink(reviewerId: number, linkId: number) {
  return asUser(reviewerId, (c) => c.query("UPDATE core.claim_source SET checked_by = $1 WHERE id = $2", [reviewerId, linkId]));
}

export async function setStatus(userId: number, claimId: number, status: string, extra: Record<string, string> = {}) {
  return asUser(userId, (c) => {
    const sets = ["status = $2", ...Object.keys(extra).map((k, i) => `${k} = $${i + 3}`)];
    return c.query(`UPDATE core.claim SET ${sets.join(", ")} WHERE id = $1`, [claimId, status, ...Object.values(extra)]);
  });
}

/** Full happy path: draft → pending_review → verified → published. */
export async function publishIdentity(team: Team, institutionId: number) {
  const claim = await createClaim(team.researcher, { institutionId });
  const src = await createSource(team.researcher);
  const link = await linkSource(team.researcher, claim.id, src);
  await setStatus(team.researcher, claim.id, "pending_review");
  await confirmLink(team.reviewer, link);
  await setStatus(team.reviewer, claim.id, "verified");
  await setStatus(team.publisher, claim.id, "published");
  return claim;
}
