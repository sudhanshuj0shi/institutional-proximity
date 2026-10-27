// Starts the app against a throwaway database populated with CLEARLY FICTIONAL fixture
// records ("Fixture …"), published through the real workflow by fixture reviewer accounts.
// Used only by the Playwright tests. Never point this at a real database.
import pg from "pg";
import { migrate } from "../../src/db/migrate.js";

const ADMIN = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = "ip_e2e";
const host = new URL(ADMIN).host;
const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
const owner = `postgres://postgres@${host}/${DB}`;
await migrate(owner, { publicPassword: "e2e_public_pw", editorPassword: "e2e_editor_pw" });
process.env.DATABASE_URL_OWNER = owner;
process.env.DATABASE_URL_PUBLIC = `postgres://ip_public:e2e_public_pw@${host}/${DB}`;
process.env.DATABASE_URL_EDITOR = `postgres://ip_editor:e2e_editor_pw@${host}/${DB}`;
process.env.SESSION_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123456789";

const H = await import("../helpers.js");
const team = await H.makeTeam();

async function publish(claim: { id: number }, sourceOpts: Parameters<typeof H.createSource>[1] = {}) {
  const src = await H.createSource(team.researcher, sourceOpts);
  const link = await H.linkSource(team.researcher, claim.id, src, { section: "Fixture section 1", excerpt: "Fixture excerpt." });
  await H.setStatus(team.researcher, claim.id, "pending_review");
  await H.confirmLink(team.reviewer, link);
  await H.setStatus(team.reviewer, claim.id, "verified");
  await H.setStatus(team.publisher, claim.id, "published");
}
async function entity(sql: string, params: unknown[]) {
  return H.asUser(team.researcher, async (c) => (await c.query(sql, params)).rows[0].id as number);
}
async function claim(kind: string, subject: { inst?: number; person?: number }, text: string) {
  return H.createClaim(team.researcher, { kind, institutionId: subject.inst, personId: subject.person, text });
}
async function record(sql: string, params: unknown[]) { return H.asUser(team.researcher, async (c) => (await c.query(sql, params)).rows[0]?.id as number); }

const instSql = "INSERT INTO core.institution (slug, canonical_name, short_name, entity_kind, legal_category) VALUES ($1,$2,$3,$4,$5) RETURNING id";
const A = await entity(instSql, ["fixture-commission-a", "Fixture Commission A", "Fixture A", "independent_institution", "statutory_body"]);
const G = await entity(instSql, ["fixture-appointing-office", "Fixture Appointing Office", null, "government_body", "constitutional_office"]);
const S = await entity(instSql, ["fixture-selection-panel", "Fixture Selection Panel", null, "selection_body", "statutory_body"]);
const P1 = await entity("INSERT INTO core.person (slug, canonical_name) VALUES ($1,$2) RETURNING id", ["fixture-person-one", "Fixture Person One"]);
const P2 = await entity("INSERT INTO core.person (slug, canonical_name) VALUES ($1,$2) RETURNING id", ["fixture-person-two", "Fixture Person Two"]);

for (const [id, name] of [[A, "Fixture Commission A"], [G, "Fixture Appointing Office"], [S, "Fixture Selection Panel"]] as const) {
  await publish(await claim("identity", { inst: id }, `${name} is a fictional fixture body used only for automated tests.`));
}
for (const [id, name] of [[P1, "Fixture Person One"], [P2, "Fixture Person Two"]] as const) {
  await publish(await claim("identity", { person: id }, `${name} is a fictional fixture person used only for automated tests.`));
}
await publish(await claim("mandate", { inst: A }, "Fixture Commission A is assigned fictional fixture functions by a fictional fixture statute."));

const pc = await claim("appointment_process", { inst: A }, "The fictional fixture statute provides a three-stage appointment process.");
const proc = await record(`INSERT INTO core.appointment_process (claim_id, institution_id, office_title, legal_basis, process_description, effective_from, effective_from_precision)
  VALUES ($1,$2,'Fixture Commissioner','Fixture Act, section 7','A fictional panel recommends and a fictional office appoints.','2020-01-01','year') RETURNING id`, [pc.id, A]);
await publish(pc);
for (const [seq, title, actor, actorInst] of [[1, "Fixture panel shortlists", "Fixture Selection Panel", S], [2, "Fixture panel recommends", "Fixture Selection Panel", S], [3, "Fixture office appoints", "Fixture Appointing Office", G]] as const) {
  const sc = await claim("appointment_stage", { inst: A }, `Fixture stage ${seq}: ${title}.`);
  await record(`INSERT INTO core.appointment_stage (claim_id, process_id, seq, stage_title, actor_label, actor_institution_id, role_description, provision_label)
    VALUES ($1,$2,$3,$4,$5,$6,'A fictional role description for this fixture stage.','Fixture s.7') RETURNING id`, [sc.id, proc, seq, title, actor, actorInst]);
  await publish(sc);
}
for (const [dim, label] of [["tenure", "Fixture s.9"], ["removal", "Fixture s.11"]]) {
  const sg = await claim("safeguard", { inst: A }, `Fixture ${dim} safeguard statement.`);
  await record(`INSERT INTO core.safeguard (claim_id, institution_id, dimension, provision_label, establishes, does_not_establish)
    VALUES ($1,$2,$3,$4,'A fictional fixture protection.','It does not establish anything about practice.') RETURNING id`, [sg.id, A, dim, label]);
  await publish(sg);
}
const pos = async (person: number, title: string, start: string, sp: string, end: string | null, ep: string) => {
  const c = await claim("position", { person }, `Fixture record of ${title}.`);
  await record(`INSERT INTO core.position (claim_id, person_id, institution_id, title, start_date, start_precision, end_date, end_precision, appointment_type, appointing_authority_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'appointed',$9) RETURNING id`, [c.id, person, A, title, start, sp, end, ep, G]);
  await publish(c);
};
await pos(P1, "Fixture Commissioner", "2018-01-01", "year", "2021-03-01", "month");
await pos(P2, "Fixture Commissioner", "2021-04-12", "day", null, "unknown");
for (const [src, tgt, type] of [[S, A, "participates_in_appointment_of"], [G, A, "participates_in_appointment_of"], [A, G, "formally_reports_to"]] as const) {
  const c = await claim("relationship", { inst: src }, "Fixture relationship statement.");
  await record(`INSERT INTO core.relationship (claim_id, source_institution_id, target_institution_id, relationship_type, description)
    VALUES ($1,$2,$3,$4,'A fictional, documented structural relationship used for tests.') RETURNING id`, [c.id, src, tgt, type]);
  await publish(c);
}
const ev = async (type: string, title: string, date: string, status: string) => {
  const c = await claim("legal_event", { inst: A }, `Fixture event: ${title}.`);
  const id = await record(`INSERT INTO core.legal_event (claim_id, institution_id, event_type, title, event_date, event_precision, procedural_status)
    VALUES ($1,$2,$3,$4,$5,'day',$6) RETURNING id`, [c.id, A, type, title, date, status]);
  await publish(c);
  return id;
};
await ev("bill_introduced", "Fixture Bill introduced", "2019-07-01", "Proposed; not law.");
await ev("act_enacted", "Fixture Act enacted", "2019-12-01", "Enacted.");

const { createApp } = await import("../../src/server.js");
const port = Number(process.env.E2E_PORT ?? 3100);
createApp().listen(port, () => console.log(`e2e fixture server on ${port}`));
