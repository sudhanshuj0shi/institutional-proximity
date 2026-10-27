// Publishes AI-checked claims, as authorised by the site owner on 27 Oct 2026.
//
// Runs as a NON-HUMAN account holding the `ai_reviewer` role, so every claim it publishes
// is recorded and displayed as "Checked by AI, not yet by a person". It only acts on
// claims imported by the research-import account whose supporting sources were all opened
// (have an access date) during the AI review pass; it never touches sensitive claims (the database forbids it anyway).
// Claims that fail any rule stay where they are and are reported.
import pg from "pg";
import { fileURLToPath } from "node:url";

const AI_USER = "ai-review";
const ORDER: Record<string, number> = {
  identity: 0, legal_basis: 1, mandate: 1, composition: 1, funding: 1, accountability: 1, other: 1, safeguard: 1,
  appointment_process: 2, position: 3, relationship: 3, legal_event: 3, appointment_stage: 4,
};

export async function aiPublish(ownerUrl: string, log = false) {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  const published: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  try {
    await c.query("BEGIN");
    let uid = (await c.query("SELECT id FROM core.app_user WHERE username = $1", [AI_USER])).rows[0]?.id as number | undefined;
    if (!uid) {
      uid = (await c.query(
        `INSERT INTO core.app_user (username, display_name, public_role_label, roles, is_human)
         VALUES ($1, 'AI reviewer (automated)', 'AI reviewer', '{researcher,ai_reviewer}', false) RETURNING id`, [AI_USER])).rows[0].id;
    }
    await c.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.change_reason', 'AI check and publish, authorised by the site owner', true), set_config('app.review_notes', $2, true)",
      [String(uid), "AI reviewer: supporting sources were opened by an automated tool on 27 Oct 2026 and the cited passages located. Not reviewed by a person."]);

    const candidates = (await c.query(`
      SELECT c.id, c.public_id, c.kind, c.is_sensitive,
             EXISTS (SELECT 1 FROM core.claim_source cs JOIN core.source s ON s.id = cs.source_id
                     WHERE cs.claim_id = c.id AND cs.evidence_role = 'supports' AND s.accessed_at IS NULL) AS unopened
      FROM core.claim c JOIN core.app_user u ON u.id = c.created_by
      -- Only the candidate set the AI actually reviewed (created by the research import account).
      -- Claims written by people are never auto-published.
      WHERE c.status = 'pending_review' AND u.username = 'research-import' ORDER BY c.id`)).rows as { id: number; public_id: string; kind: string; is_sensitive: boolean; unopened: boolean }[];

    const queue = candidates.filter((x) => {
      if (x.is_sensitive) { skipped.push({ id: x.public_id, reason: "Sensitive: a person must check and publish it." }); return false; }
      if (x.unopened) { skipped.push({ id: x.public_id, reason: "A supporting source has not been opened (no access date)." }); return false; }
      return true;
    }).sort((a, b) => (ORDER[a.kind] ?? 5) - (ORDER[b.kind] ?? 5) || a.id - b.id);

    // Repeat until no progress, so dependencies (identity → record) resolve in order.
    let pending = queue;
    for (let pass = 0; pass < 6 && pending.length; pass++) {
      const next: typeof pending = [];
      for (const x of pending) {
        await c.query("SAVEPOINT one");
        try {
          await c.query("UPDATE core.claim_source SET checked_by = $2 WHERE claim_id = $1 AND evidence_role = 'supports' AND checked_by IS NULL", [x.id, uid]);
          await c.query("UPDATE core.claim SET status = 'verified' WHERE id = $1", [x.id]);
          await c.query("UPDATE core.claim SET status = 'published' WHERE id = $1", [x.id]);
          await c.query("RELEASE SAVEPOINT one");
          published.push(x.public_id);
        } catch (err) {
          await c.query("ROLLBACK TO SAVEPOINT one");
          (x as typeof x & { err?: string }).err = (err as Error).message;
          next.push(x);
        }
      }
      if (next.length === pending.length) { pending = next; break; }
      pending = next;
    }
    for (const x of pending) skipped.push({ id: x.public_id, reason: (x as typeof x & { err?: string }).err ?? "Not eligible." });
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
  if (log) {
    console.log(`Published ${published.length} AI-checked claims.`);
    for (const s of skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
  }
  return { published, skipped };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { config } = await import("../config.js");
  await aiPublish(config.ownerUrl, true);
}
