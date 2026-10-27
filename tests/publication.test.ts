import { describe, it, expect, beforeAll } from "vitest";
import {
  makeTeam, Team, createInstitution, createPerson, createClaim, createSource, linkSource, confirmLink,
  setStatus, publishIdentity, publicQuery, asUser, ownerClient, uid,
} from "./helpers.js";

let team: Team;
beforeAll(async () => { team = await makeTeam(); });

async function readyForVerification(opts: Parameters<typeof createClaim>[1] = {}, srcType = "legislation") {
  const inst = opts.institutionId ?? await createInstitution(team.researcher);
  const claim = await createClaim(team.researcher, { institutionId: inst, ...opts });
  const src = await createSource(team.researcher, { type: srcType });
  const link = await linkSource(team.researcher, claim.id, src);
  await setStatus(team.researcher, claim.id, "pending_review");
  return { inst, claim, src, link };
}

describe("publication controls (enforced in the database)", () => {
  it("new claims must start as draft — a client cannot insert a published claim", async () => {
    const inst = await createInstitution(team.researcher);
    await expect(asUser(team.publisher, (c) => c.query(
      `INSERT INTO core.claim (kind, claim_text, claim_category, subject_institution_id, status)
       VALUES ('identity', 'Attempted direct publication of a claim.', 'verified_fact', $1, 'published')`, [inst],
    ))).rejects.toThrow(/must start as draft/);
  });

  it("a draft claim never appears in any public view", async () => {
    const inst = await createInstitution(team.researcher);
    const claim = await createClaim(team.researcher, { institutionId: inst });
    const rows = await publicQuery("SELECT * FROM public_api.claims WHERE public_id = $1", [claim.public_id]);
    expect(rows).toHaveLength(0);
    expect(await publicQuery("SELECT * FROM public_api.institutions WHERE id = $1", [inst])).toHaveLength(0);
  });

  it("an unverified claim cannot be published (no skipping states)", async () => {
    const { claim } = await readyForVerification();
    await expect(setStatus(team.publisher, claim.id, "published")).rejects.toThrow(/not permitted/);
    const inst = await createInstitution(team.researcher);
    const draft = await createClaim(team.researcher, { institutionId: inst });
    await expect(setStatus(team.reviewer, draft.id, "verified")).rejects.toThrow(/not permitted/);
  });

  it("verification requires a reviewer role, a human, and someone other than the author", async () => {
    const { claim, link } = await readyForVerification();
    await confirmLink(team.reviewer, link);
    await expect(setStatus(team.researcher, claim.id, "verified")).rejects.toThrow(/requires the reviewer role/);
    await expect(setStatus(team.bot, claim.id, "verified")).rejects.toThrow(/requires the reviewer role/);

    // Author who is also a reviewer still cannot verify their own claim.
    const inst = await createInstitution(team.reviewer2);
    const own = await createClaim(team.reviewer2, { institutionId: inst });
    const src = await createSource(team.reviewer2);
    const l2 = await linkSource(team.reviewer2, own.id, src);
    await setStatus(team.reviewer2, own.id, "pending_review");
    await confirmLink(team.reviewer2, l2);
    await expect(setStatus(team.reviewer2, own.id, "verified")).rejects.toThrow(/other than its author/);
  });

  it("automated accounts can never hold reviewer or publisher roles", async () => {
    const o = ownerClient(); await o.connect();
    await expect(o.query(
      "INSERT INTO core.app_user (username, display_name, roles, is_human) VALUES ($1, 'Bot', '{reviewer}', false)", [`bot_${uid()}`],
    )).rejects.toThrow(/non_human_cannot_review/);
    await o.end();
  });

  it("a source check can only be confirmed by a reviewer for themselves", async () => {
    const { link } = await readyForVerification();
    await expect(confirmLink(team.researcher, link)).rejects.toThrow(/Only a reviewer can confirm/);
    await expect(asUser(team.reviewer, (c) => c.query("UPDATE core.claim_source SET checked_by = $1 WHERE id = $2", [team.reviewer2, link])))
      .rejects.toThrow(/Only a reviewer can confirm/);
  });

  it("missing or invalid evidence prevents verification", async () => {
    // No source at all.
    const inst = await createInstitution(team.researcher);
    const bare = await createClaim(team.researcher, { institutionId: inst });
    await setStatus(team.researcher, bare.id, "pending_review");
    await expect(setStatus(team.reviewer, bare.id, "verified")).rejects.toThrow(/No supporting source/);

    // Unchecked link.
    const a = await readyForVerification();
    await expect(setStatus(team.reviewer, a.claim.id, "verified")).rejects.toThrow(/not been confirmed by a reviewer/);

    // Discovery (tier 3) source alone.
    const b = await readyForVerification({}, "discovery_other");
    await confirmLink(team.reviewer, b.link);
    await expect(setStatus(team.reviewer, b.claim.id, "verified")).rejects.toThrow(/Discovery sources cannot establish/);

    // Missing section reference.
    const inst2 = await createInstitution(team.researcher);
    const c = await createClaim(team.researcher, { institutionId: inst2 });
    const s = await createSource(team.researcher);
    const l = await linkSource(team.researcher, c.id, s, { section: null });
    await setStatus(team.researcher, c.id, "pending_review");
    await confirmLink(team.reviewer, l);
    await expect(setStatus(team.reviewer, c.id, "verified")).rejects.toThrow(/lack a page, article, section/);

    // Source never accessed.
    const inst3 = await createInstitution(team.researcher);
    const d = await createClaim(team.researcher, { institutionId: inst3 });
    const s3 = await createSource(team.researcher, { accessed: null });
    const l3 = await linkSource(team.researcher, d.id, s3);
    await setStatus(team.researcher, d.id, "pending_review");
    await confirmLink(team.reviewer, l3);
    await expect(setStatus(team.reviewer, d.id, "verified")).rejects.toThrow(/no recorded access date/);
  });

  it("sensitive claims need a primary (tier 1) source", async () => {
    const { claim, link } = await readyForVerification({ sensitive: true }, "news_report");
    await confirmLink(team.reviewer, link);
    await expect(setStatus(team.reviewer, claim.id, "verified")).rejects.toThrow(/tier 1/);
  });

  it("contradictory evidence must be acknowledged under known limitations", async () => {
    const { claim, link } = await readyForVerification();
    const other = await createSource(team.researcher);
    await linkSource(team.researcher, claim.id, other, { role: "contradicts", section: "Para 2" });
    await confirmLink(team.reviewer, link);
    await expect(setStatus(team.reviewer, claim.id, "verified")).rejects.toThrow(/Contradictory evidence/);
    // Contradictory records are preserved for review, not discarded.
    const o = ownerClient(); await o.connect();
    const n = (await o.query("SELECT count(*)::int AS n FROM core.claim_source WHERE claim_id = $1", [claim.id])).rows[0].n;
    await o.end();
    expect(n).toBe(2);
  });

  it("publishing requires the publisher role and a publishable category", async () => {
    const { claim, link } = await readyForVerification();
    await confirmLink(team.reviewer, link);
    await setStatus(team.reviewer, claim.id, "verified");
    await expect(setStatus(team.reviewer, claim.id, "published")).rejects.toThrow(/requires the publisher role/);
    await setStatus(team.publisher, claim.id, "published");

    const allegation = await readyForVerification({ category: "reported_allegation" });
    await confirmLink(team.reviewer, allegation.link);
    await setStatus(team.reviewer, allegation.claim.id, "verified");
    await expect(setStatus(team.publisher, allegation.claim.id, "published")).rejects.toThrow(/Only verified facts and official findings/);
  });

  it("the full workflow publishes a claim, records reviews, and exposes evidence without internal notes", async () => {
    const inst = await createInstitution(team.researcher);
    const claim = await publishIdentity(team, inst);
    const rows = await publicQuery("SELECT * FROM public_api.claims WHERE public_id = $1", [claim.public_id]);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).not.toContain("review_notes");
    const ev = await publicQuery("SELECT * FROM public_api.claim_evidence WHERE claim_id = $1", [claim.public_id]);
    expect(ev).toHaveLength(1);
    for (const forbidden of ["verification_notes", "source_notes", "checked_by", "created_by"]) {
      expect(Object.keys(ev[0])).not.toContain(forbidden);
    }
    const o = ownerClient(); await o.connect();
    const reviews = (await o.query("SELECT from_status, to_status FROM core.review WHERE claim_id = $1 ORDER BY id", [claim.id])).rows;
    await o.end();
    expect(reviews.map((r) => `${r.from_status}>${r.to_status}`)).toEqual([
      "draft>pending_review", "pending_review>verified", "verified>published",
    ]);
  });

  it("disputed and needs_reverification claims are hidden from public views", async () => {
    for (const state of ["disputed", "needs_reverification"]) {
      const inst = await createInstitution(team.researcher);
      const claim = await publishIdentity(team, inst);
      expect(await publicQuery("SELECT 1 FROM public_api.claims WHERE public_id = $1", [claim.public_id])).toHaveLength(1);
      await setStatus(team.researcher, claim.id, state);
      expect(await publicQuery("SELECT 1 FROM public_api.claims WHERE public_id = $1", [claim.public_id])).toHaveLength(0);
      expect(await publicQuery("SELECT 1 FROM public_api.institutions WHERE id = $1", [inst])).toHaveLength(0);
      const w = await publicQuery("SELECT * FROM public_api.withdrawals WHERE claim_id = $1", [claim.public_id]);
      expect(w[0].withdrawal_type).toBe("temporarily_withdrawn");
    }
  });

  it("retracting a published claim requires a public note, hides it, and never re-exposes its text", async () => {
    const inst = await createInstitution(team.researcher);
    const claim = await publishIdentity(team, inst);
    await expect(setStatus(team.publisher, claim.id, "retracted")).rejects.toThrow(/public correction note/);
    await setStatus(team.publisher, claim.id, "retracted", { public_correction_note: "Withdrawn after review of the source." });
    expect(await publicQuery("SELECT 1 FROM public_api.claims WHERE public_id = $1", [claim.public_id])).toHaveLength(0);
    const w = await publicQuery("SELECT * FROM public_api.withdrawals WHERE claim_id = $1", [claim.public_id]);
    expect(w[0].withdrawal_type).toBe("withdrawn");
    expect(Object.keys(w[0])).not.toContain("claim_text");
    // Retraction is terminal.
    await expect(setStatus(team.reviewer, claim.id, "pending_review")).rejects.toThrow(/not permitted/);
  });

  it("content and evidence of a published claim are locked", async () => {
    const inst = await createInstitution(team.researcher);
    const claim = await publishIdentity(team, inst);
    await expect(asUser(team.publisher, (c) => c.query("UPDATE core.claim SET claim_text = 'Changed text after publication.' WHERE id = $1", [claim.id])))
      .rejects.toThrow(/needs_reverification before changing/);
    const s = await createSource(team.researcher);
    await expect(linkSource(team.researcher, claim.id, s)).rejects.toThrow(/locked/);
    const o = ownerClient(); await o.connect();
    const srcId = (await o.query("SELECT source_id FROM core.claim_source WHERE claim_id = $1", [claim.id])).rows[0].source_id;
    await o.end();
    await expect(asUser(team.researcher, (c) => c.query("UPDATE core.source SET canonical_url = 'https://example.org/other' WHERE id = $1", [srcId])))
      .rejects.toThrow(/bibliographic details are locked/);
  });

  it("a source becoming unavailable flags its claims for re-verification without hiding or deleting them", async () => {
    const inst = await createInstitution(team.researcher);
    const claim = await publishIdentity(team, inst);
    const o = ownerClient(); await o.connect();
    const srcId = (await o.query("SELECT source_id FROM core.claim_source WHERE claim_id = $1", [claim.id])).rows[0].source_id;
    await asUser(team.researcher, (c) => c.query("UPDATE core.source SET availability = 'unavailable' WHERE id = $1", [srcId]));
    const row = (await o.query("SELECT status, attention_reason FROM core.claim WHERE id = $1", [claim.id])).rows[0];
    await o.end();
    expect(row.status).toBe("published");
    expect(row.attention_reason).toMatch(/does not mean the claim is false/);
  });

  it("writes without an editorial actor are rejected", async () => {
    const pg = (await import("pg")).default;
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL_EDITOR });
    await c.connect();
    await expect(c.query(`INSERT INTO core.institution (slug, canonical_name, entity_kind, legal_category)
      VALUES ('test-no-actor', 'Test No Actor', 'government_body', 'other')`)).rejects.toThrow(/No active editorial user/);
    await c.end();
  });

  it("the public role cannot read or write internal tables", async () => {
    await expect(publicQuery("SELECT * FROM core.claim")).rejects.toThrow(/permission denied/);
    await expect(publicQuery("UPDATE core.claim SET status = 'published'")).rejects.toThrow(/permission denied/);
    await expect(publicQuery("SELECT * FROM core.app_user")).rejects.toThrow(/permission denied/);
  });

  it("correction requests are stored privately and never create claims", async () => {
    const before = (await publicQuery("SELECT * FROM public_api.site_status"))[0];
    const ref = (await publicQuery("SELECT public_api.submit_correction($1,$2,$3,$4,$5) AS ref",
      ["C-000001", "/institutions/x", "The date shown appears to be wrong.", "", ""]))[0].ref;
    expect(ref).toMatch(/^R-\d{5}$/);
    const after = (await publicQuery("SELECT * FROM public_api.site_status"))[0];
    expect(after).toEqual(before);
  });

  it("material changes are written to an append-only audit log", async () => {
    const inst = await createInstitution(team.researcher);
    const o = ownerClient(); await o.connect();
    const rows = (await o.query("SELECT * FROM core.audit_log WHERE entity_type = 'institution' AND entity_id = $1", [String(inst)])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].changed_by).toBe(team.researcher);
    await expect(o.query("UPDATE core.audit_log SET reason = 'x' WHERE id = $1", [rows[0].id])).rejects.toThrow(/append-only/);
    await expect(o.query("DELETE FROM core.audit_log WHERE id = $1", [rows[0].id])).rejects.toThrow(/append-only/);
    await o.end();
  });
});

describe("relationship and record integrity", () => {
  it("rejects invalid entity references, unsupported types, and self-loops", async () => {
    const inst = await createInstitution(team.researcher);
    const claim = await createClaim(team.researcher, { kind: "relationship", institutionId: inst });
    const insert = (src: number, tgt: number, type = "formally_reports_to") => asUser(team.researcher, (c) => c.query(
      `INSERT INTO core.relationship (claim_id, source_institution_id, target_institution_id, relationship_type, description)
       VALUES ($1, $2, $3, $4, 'Test relationship description.')`, [claim.id, src, tgt, type]));
    await expect(insert(inst, 99999999)).rejects.toThrow(/foreign key/);
    await expect(insert(inst, inst)).rejects.toThrow(/check constraint/);
    const other = await createInstitution(team.researcher);
    await expect(insert(inst, other, "political_connection")).rejects.toThrow(/invalid input value for enum/);
    await insert(inst, other); // valid
  });

  it("a record must be backed by a claim of the matching kind and subject", async () => {
    const inst = await createInstitution(team.researcher);
    const other = await createInstitution(team.researcher);
    const identityClaim = await createClaim(team.researcher, { institutionId: inst });
    await expect(asUser(team.researcher, (c) => c.query(
      `INSERT INTO core.safeguard (claim_id, institution_id, dimension, provision_label, establishes, does_not_establish)
       VALUES ($1, $2, 'tenure', 'Test s.1', 'Test establishes text.', 'Test does-not text.')`, [identityClaim.id, inst],
    ))).rejects.toThrow(/kind identity, not safeguard/);
    const sgClaim = await createClaim(team.researcher, { kind: "safeguard", institutionId: inst });
    await expect(asUser(team.researcher, (c) => c.query(
      `INSERT INTO core.safeguard (claim_id, institution_id, dimension, provision_label, establishes, does_not_establish)
       VALUES ($1, $2, 'tenure', 'Test s.1', 'Test establishes text.', 'Test does-not text.')`, [sgClaim.id, other],
    ))).rejects.toThrow(/subject must be one of the entities/);
  });

  it("a position cannot be published until its endpoints are public, and only then appears in public views", async () => {
    const inst = await createInstitution(team.researcher);
    const person = await createPerson(team.researcher);
    const claim = await createClaim(team.researcher, { kind: "position", personId: person });
    await asUser(team.researcher, (c) => c.query(
      `INSERT INTO core.position (claim_id, person_id, institution_id, title, start_date, start_precision)
       VALUES ($1, $2, $3, 'Test Office', '2020-01-01', 'year')`, [claim.id, person, inst]));
    const src = await createSource(team.researcher);
    const link = await linkSource(team.researcher, claim.id, src);
    await setStatus(team.researcher, claim.id, "pending_review");
    await confirmLink(team.reviewer, link);
    await setStatus(team.reviewer, claim.id, "verified");
    await expect(setStatus(team.publisher, claim.id, "published")).rejects.toThrow(/no published identity claim/);

    await publishIdentity(team, inst);
    const pc = await createClaim(team.researcher, { personId: person });
    const ps = await createSource(team.researcher);
    const pl = await linkSource(team.researcher, pc.id, ps);
    await setStatus(team.researcher, pc.id, "pending_review");
    await confirmLink(team.reviewer, pl);
    await setStatus(team.reviewer, pc.id, "verified");
    await setStatus(team.publisher, pc.id, "published");

    await setStatus(team.publisher, claim.id, "published");
    const rows = await publicQuery("SELECT * FROM public_api.positions WHERE claim_id = $1", [claim.public_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].start_precision).toBe("year");
  });
});

describe("source and date integrity", () => {
  it("rejects malformed and non-http URLs", async () => {
    for (const url of ["javascript:alert(1)", "ftp://example.org/x", "not a url", "https://exa mple.org"]) {
      await expect(createSource(team.researcher, { url })).rejects.toThrow(/check constraint/);
    }
  });

  it("never stores more date precision than the source provides", async () => {
    const inst = await createInstitution(team.researcher);
    const claim = await createClaim(team.researcher, { kind: "legal_event", institutionId: inst });
    const ins = (d: string | null, p: string) => asUser(team.researcher, (c) => c.query(
      `INSERT INTO core.legal_event (claim_id, institution_id, event_type, title, event_date, event_precision)
       VALUES ($1, $2, 'act_enacted', 'Test Act', $3, $4)`, [claim.id, inst, d, p]));
    await expect(ins("2019-08-01", "year")).rejects.toThrow(/check constraint/);
    await expect(ins("2019-01-01", "unknown")).rejects.toThrow(/check constraint/);
    await expect(ins(null, "day")).rejects.toThrow(/check constraint/);
    await ins(null, "unknown"); // honest unknown is allowed
  });
});

describe("AI-checked tier (always disclosed)", () => {
  async function aiPublish(opts: Parameters<typeof createClaim>[1] = {}) {
    const inst = opts.institutionId ?? await createInstitution(team.researcher);
    const claim = await createClaim(team.researcher, { institutionId: inst, ...opts });
    const src = await createSource(team.researcher);
    const link = await linkSource(team.researcher, claim.id, src);
    await setStatus(team.researcher, claim.id, "pending_review");
    await confirmLink(team.ai, link);
    await setStatus(team.ai, claim.id, "verified");
    await setStatus(team.ai, claim.id, "published");
    return { claim, link, inst };
  }

  it("an AI reviewer can verify and publish a non-sensitive claim, and the public view says so", async () => {
    const { claim } = await aiPublish();
    const rows = await publicQuery("SELECT verification_basis FROM public_api.claims WHERE public_id = $1", [claim.public_id]);
    expect(rows[0].verification_basis).toBe("ai");
    const ev = await publicQuery("SELECT check_basis FROM public_api.claim_evidence WHERE claim_id = $1", [claim.public_id]);
    expect(ev[0].check_basis).toBe("ai");
    const status = (await publicQuery("SELECT * FROM public_api.site_status"))[0];
    expect(Number(status.published_ai_checked)).toBeGreaterThan(0);
  });

  it("an AI reviewer can never verify a sensitive claim", async () => {
    const { claim, link } = await readyForVerification({ sensitive: true });
    await confirmLink(team.ai, link);
    await expect(setStatus(team.ai, claim.id, "verified")).rejects.toThrow(/Sensitive claims must be verified and published by a person/);
  });

  it("an AI reviewer cannot retract, and an automated account without the role cannot verify", async () => {
    const { claim } = await aiPublish();
    await expect(setStatus(team.ai, claim.id, "retracted", { public_correction_note: "x note" })).rejects.toThrow(/requires the publisher role/);
    const r = await readyForVerification();
    await expect(confirmLink(team.bot, r.link)).rejects.toThrow(/Only a reviewer can confirm/);
  });

  it("a human cannot be recorded as the AI, and the ai_reviewer role cannot be given to a person", async () => {
    const o = ownerClient(); await o.connect();
    await expect(o.query("UPDATE core.app_user SET roles = '{reviewer,ai_reviewer}' WHERE id = $1", [team.reviewer])).rejects.toThrow(/ai_reviewer_is_not_human/);
    await o.end();
  });

  it("a person's verification requires every source re-confirmed by a person, and then upgrades the label", async () => {
    const { claim, link } = await aiPublish();
    await setStatus(team.researcher, claim.id, "needs_reverification");
    await setStatus(team.researcher, claim.id, "pending_review");
    await expect(setStatus(team.reviewer, claim.id, "verified")).rejects.toThrow(/Re-confirm the sources checked by AI/);
    await confirmLink(team.reviewer, link);
    await setStatus(team.reviewer, claim.id, "verified");
    await setStatus(team.publisher, claim.id, "published");
    const rows = await publicQuery("SELECT verification_basis FROM public_api.claims WHERE public_id = $1", [claim.public_id]);
    expect(rows[0].verification_basis).toBe("human");
  });

  it("an AI reviewer cannot publish a claim a person verified", async () => {
    const { claim, link } = await readyForVerification();
    await confirmLink(team.reviewer, link);
    await setStatus(team.reviewer, claim.id, "verified");
    await expect(setStatus(team.ai, claim.id, "published")).rejects.toThrow(/cannot publish a claim verified by a person/);
  });
});

describe("AI publish script", () => {
  it("never publishes claims written by people", async () => {
    const { aiPublish } = await import("../src/db/ai-publish.js");
    const { claim } = await readyForVerification();
    const res = await aiPublish(process.env.DATABASE_URL_OWNER!);
    expect(res.published).not.toContain(claim.public_id);
    const o = ownerClient(); await o.connect();
    expect((await o.query("SELECT status FROM core.claim WHERE id = $1", [claim.id])).rows[0].status).toBe("pending_review");
    await o.end();
  });
});
