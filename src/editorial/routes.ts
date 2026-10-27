import { Router, type Request, type Response, type NextFunction } from "express";
import type pg from "pg";
import { html, safeHref, SafeHtml } from "../lib/html.js";
import { page } from "../lib/layout.js";
import { formatDated, formatTimestamp } from "../lib/dates.js";
import {
  categoryLabel, kindLabel, label, legalCategoryLabel, entityKindLabel, sourceTypeLabel, statusLabel, tierLabel,
} from "../lib/labels.js";
import { getEditorPool, withActor } from "../db/pool.js";
import { int, isHttpUrl, oneOf, optStr, parseDated, slugify, str } from "../lib/validate.js";
import { rateLimit } from "../lib/security.js";
import {
  createSession, destroySession, hashPassword, hasRole, loadSession, requireCsrf, requireEditor, requireRole, verifyPassword,
} from "./auth.js";
import { FACET_KINDS, parseFields, RECORD_SPECS, insertRecord, rowToForm, updateRecord, type Field } from "./records.js";
import { languageWarnings } from "./language.js";

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);
const db = () => getEditorPool();

const STATUSES = ["draft", "researching", "pending_review", "verified", "published", "needs_reverification", "disputed", "retracted"] as const;
const CATEGORIES = ["verified_fact", "official_finding", "reported_allegation", "analytical_interpretation", "unknown"] as const;
const SOURCE_TYPES = Object.keys(sourceTypeLabel);
const ROLES = ["researcher", "reviewer", "publisher", "admin"] as const;
const EDITABLE = new Set(["draft", "researching", "pending_review", "needs_reverification", "disputed"]);

/** Same table as core.transition_role in the database; used only to decide which buttons to show. */
const TRANSITIONS: Record<string, { to: string; role: "editor" | "reviewer" | "publisher"; label: string }[]> = {
  draft: [{ to: "researching", role: "editor", label: "Mark as researching" }, { to: "pending_review", role: "editor", label: "Submit for review" }],
  researching: [{ to: "pending_review", role: "editor", label: "Submit for review" }, { to: "draft", role: "editor", label: "Return to draft" }],
  pending_review: [
    { to: "verified", role: "reviewer", label: "Verify" }, { to: "researching", role: "editor", label: "Return for more research" },
    { to: "disputed", role: "reviewer", label: "Mark disputed" }, { to: "retracted", role: "publisher", label: "Retract" }],
  verified: [
    { to: "published", role: "publisher", label: "Publish" }, { to: "researching", role: "reviewer", label: "Return for more research" },
    { to: "needs_reverification", role: "editor", label: "Flag for re-verification" }, { to: "disputed", role: "editor", label: "Mark disputed" },
    { to: "retracted", role: "publisher", label: "Retract" }],
  published: [
    { to: "needs_reverification", role: "editor", label: "Take down for re-verification" }, { to: "disputed", role: "editor", label: "Take down as disputed" },
    { to: "retracted", role: "publisher", label: "Retract" }],
  needs_reverification: [{ to: "pending_review", role: "editor", label: "Resubmit for review" }, { to: "researching", role: "editor", label: "Return for more research" }, { to: "retracted", role: "publisher", label: "Retract" }],
  disputed: [{ to: "pending_review", role: "reviewer", label: "Resubmit for review" }, { to: "retracted", role: "publisher", label: "Retract" }],
  retracted: [],
};

const MESSAGES: Record<string, string> = {
  created: "Claim created as a draft.", saved: "Changes saved.", transitioned: "Status updated.", linked: "Source attached.",
  confirmed: "Source check confirmed.", unlinked: "Source link removed.", source_created: "Source created.",
  entity_created: "Entity created. Now create an identity claim for it.", user_saved: "User saved.", correction_saved: "Report updated.",
  availability: "Availability updated.",
};

function desk(req: Request, title: string, body: SafeHtml, current = "") {
  const nav = [["/editorial", "Queue"], ["/editorial/claims/new", "New claim"], ["/editorial/entities", "Entities"],
    ["/editorial/sources", "Sources"], ["/editorial/corrections", "Correction reports"], ["/editorial/audit", "Audit log"],
    ...(hasRole(req, "admin") ? [["/editorial/users", "Users"]] : [])] as [string, string][];
  const msg = typeof req.query.msg === "string" ? MESSAGES[req.query.msg] : undefined;
  return page({
    title: `${title} — Editorial desk`, description: "Editorial desk", path: req.path, section: "editorial", noindex: true, editorial: req.editor,
    body: html`<div class="wrap">
      <nav class="desk-nav" aria-label="Editorial">${nav.map(([h, t]) => html`<a href="${h}"${current === h ? html` aria-current="page"` : ""}>${t}</a>`)}
        <form class="inline-form" method="post" action="/editorial/logout">${csrf(req)}<button class="button plain" type="submit">Sign out ${req.editor?.username}</button></form></nav>
      ${msg ? html`<div class="notice" role="status"><p>${msg}</p></div>` : ""}
      ${body}</div>`,
  });
}

const csrf = (req: Request) => html`<input type="hidden" name="_csrf" value="${req.editor?.csrf ?? ""}">`;
const send = (res: Response, status: number, body: SafeHtml) => res.status(status).type("html").send(body.value);

/** Database rule violations carry deliberate, safe messages. Anything else is generic. */
function dbErrorMessage(err: unknown): string | null {
  const e = err as { code?: string; message?: string };
  if (!e?.code) return null;
  if (["23514", "55000", "42501", "P0001"].includes(e.code)) return e.message ?? "Rule violation.";
  if (e.code === "23503") return "A referenced record does not exist.";
  if (e.code === "23505") return "That record already exists (duplicate).";
  if (e.code === "22P02" || e.code === "22007" || e.code === "22008") return "One of the values is not in an accepted format.";
  return null;
}

async function entityOptions() {
  const [i, p] = await Promise.all([
    db().query("SELECT id, canonical_name FROM core.institution ORDER BY canonical_name"),
    db().query("SELECT id, canonical_name FROM core.person ORDER BY canonical_name"),
  ]);
  return { institutions: i.rows as { id: number; canonical_name: string }[], people: p.rows as { id: number; canonical_name: string }[] };
}

async function fieldInput(f: Field, value: string, opts: Awaited<ReturnType<typeof entityOptions>>, extra: { processes: { id: number; label: string }[]; events: { id: number; label: string }[] }) {
  const req = f.required ? html` required` : "";
  const hint = f.hint ? html` <span class="hint">${f.hint}</span>` : "";
  const sel = (items: { v: string; t: string }[]) => html`<select name="${f.name}"${req}><option value="">${f.required ? "Choose…" : "None"}</option>
    ${items.map((o) => html`<option value="${o.v}"${o.v === value ? html` selected` : ""}>${o.t}</option>`)}</select>`;
  let input: SafeHtml;
  switch (f.type) {
    case "textarea": input = html`<textarea name="${f.name}" maxlength="${f.max ?? 2000}"${req}>${value}</textarea>`; break;
    case "number": input = html`<input type="number" name="${f.name}" value="${value}" min="1" max="50"${req}>`; break;
    case "day": input = html`<input type="date" name="${f.name}" value="${value}">`; break;
    case "dated": input = html`<input type="text" name="${f.name}" value="${value}" pattern="\\d{4}(-\\d{2}(-\\d{2})?)?" placeholder="YYYY or YYYY-MM or YYYY-MM-DD">`; break;
    case "enum": input = sel(Object.entries(f.options ?? {}).map(([v, t]) => ({ v, t }))); break;
    case "institution": input = sel(opts.institutions.map((o) => ({ v: String(o.id), t: o.canonical_name }))); break;
    case "person": input = sel(opts.people.map((o) => ({ v: String(o.id), t: o.canonical_name }))); break;
    case "entity": input = sel([...opts.institutions.map((o) => ({ v: `i:${o.id}`, t: `${o.canonical_name} (institution)` })),
      ...opts.people.map((o) => ({ v: `p:${o.id}`, t: `${o.canonical_name} (person)` }))]); break;
    case "process": input = sel(extra.processes.map((o) => ({ v: String(o.id), t: o.label }))); break;
    case "legal_event": input = sel(extra.events.map((o) => ({ v: String(o.id), t: o.label }))); break;
    default: input = html`<input type="text" name="${f.name}" value="${value}" maxlength="${f.max ?? 300}"${req}>`;
  }
  return html`<label>${f.label}${hint}${input}</label>`;
}

async function recordExtras() {
  const [p, e] = await Promise.all([
    db().query(`SELECT ap.id, i.canonical_name || ' — ' || ap.office_title || ' (' || ap.legal_basis || ')' AS label
                FROM core.appointment_process ap JOIN core.institution i ON i.id = ap.institution_id ORDER BY 2`),
    db().query("SELECT id, title || coalesce(' (' || event_date::text || ')', '') AS label FROM core.legal_event ORDER BY event_date NULLS LAST"),
  ]);
  return { processes: p.rows, events: e.rows };
}

function claimFields(v: Record<string, string>) {
  return html`
    <label>Claim text <span class="hint">The exact factual statement, in neutral language. Describe what the source says; do not characterise motives.</span>
      <textarea name="claim_text" required minlength="10" maxlength="2000">${v.claim_text ?? ""}</textarea></label>
    <div class="row">
      <label>Category<select name="claim_category">${CATEGORIES.map((c) => html`<option value="${c}"${(v.claim_category ?? "verified_fact") === c ? html` selected` : ""}>${categoryLabel[c]}</option>`)}</select></label>
      <label>Applies to (time period) <span class="hint">Optional</span><input type="text" name="temporal_scope" value="${v.temporal_scope ?? ""}" maxlength="300"></label>
    </div>
    <label class="check"><input type="checkbox" name="is_sensitive" value="1"${v.is_sensitive === "1" ? html` checked` : ""}> Sensitive claim (about an identifiable person's conduct, or legally consequential). Requires a primary source.</label>
    <label>Known limitations or contradictory evidence <span class="hint">Shown publicly.</span><textarea name="known_limitations" maxlength="2000">${v.known_limitations ?? ""}</textarea></label>
    <label>Internal research notes <span class="hint">Never shown publicly.</span><textarea name="review_notes" maxlength="5000">${v.review_notes ?? ""}</textarea></label>`;
}

function parseClaimBody(body: Record<string, unknown>) {
  return {
    claim_text: str(body.claim_text, 2000),
    claim_category: oneOf(body.claim_category, CATEGORIES) ?? "verified_fact",
    temporal_scope: optStr(body.temporal_scope, 300),
    is_sensitive: body.is_sensitive === "1",
    known_limitations: optStr(body.known_limitations, 2000),
    review_notes: optStr(body.review_notes, 5000),
  };
}

export function editorialRouter(): Router {
  const r = Router();
  r.use(loadSession);
  r.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  // ------------------------------------------------------------ Auth
  const loginPage = (req: Request, error?: string) => page({
    title: "Sign in — Editorial desk", description: "Editorial sign in", path: "/editorial/login", section: "editorial", noindex: true,
    body: html`<div class="wrap"><h1>Editorial desk</h1>
      <p class="quiet">For researchers, reviewers and publishers. Public readers do not need an account.</p>
      ${error ? html`<div class="notice error" role="alert"><p>${error}</p></div>` : ""}
      <form class="form" method="post" action="/editorial/login">
        <input type="hidden" name="next" value="${str(req.query.next ?? req.body?.next, 200)}">
        <label>Username<input type="text" name="username" required autocomplete="username" maxlength="40"></label>
        <label>Password<input type="password" name="password" required autocomplete="current-password" maxlength="200"></label>
        <div><button class="button" type="submit">Sign in</button></div>
      </form></div>`,
  });
  r.get("/login", (req, res) => { send(res, 200, loginPage(req)); });
  r.post("/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: "login" }), wrap(async (req, res) => {
    const username = str(req.body.username, 40).toLowerCase();
    const password = str(req.body.password, 200);
    const u = (await db().query("SELECT id, password_hash, is_human, active FROM core.app_user WHERE username = $1", [username])).rows[0];
    const ok = await verifyPassword(password, u?.password_hash ?? null);
    if (!u || !ok || !u.active || !u.is_human) return send(res, 401, loginPage(req, "That username and password do not match an active account."));
    await createSession(res, u.id);
    const next = str(req.body.next, 200);
    res.redirect(303, next.startsWith("/editorial") && !next.startsWith("//") ? next : "/editorial");
  }));

  r.use(requireEditor);
  r.use(requireCsrf);
  r.post("/logout", wrap(async (req, res) => { await destroySession(req, res); res.redirect(303, "/"); }));

  // ------------------------------------------------------------ Queue
  r.get("/", wrap(async (req, res) => {
    const me = req.editor!;
    const status = oneOf(req.query.status, STATUSES);
    const q = str(req.query.q, 100);
    const counts = (await db().query("SELECT status::text, count(*)::int AS n FROM core.claim GROUP BY status")).rows as { status: string; n: number }[];
    const params: unknown[] = [];
    const where: string[] = [];
    if (status) { params.push(status); where.push(`c.status::text = $${params.length}`); } else where.push("c.status <> 'retracted'");
    if (q) { params.push(`%${q}%`); where.push(`(c.claim_text ILIKE $${params.length} OR c.public_id ILIKE $${params.length})`); }
    const list = (await db().query(`
      SELECT c.id, c.public_id, c.kind, c.status, c.claim_text, c.attention_reason, c.updated_at, c.created_by,
             u.username AS author, u.is_human AS author_human, coalesce(i.canonical_name, p.canonical_name) AS subject
      FROM core.claim c JOIN core.app_user u ON u.id = c.created_by
      LEFT JOIN core.institution i ON i.id = c.subject_institution_id LEFT JOIN core.person p ON p.id = c.subject_person_id
      WHERE ${where.join(" AND ")} ORDER BY (c.attention_reason IS NOT NULL) DESC, c.updated_at DESC LIMIT 200`, params)).rows;
    const myReview = hasRole(req, "reviewer") ? list.filter((c) => c.status === "pending_review" && c.created_by !== me.id).length : 0;
    const toPublish = hasRole(req, "publisher") ? (counts.find((c) => c.status === "verified")?.n ?? 0) : 0;
    const openReports = (await db().query("SELECT count(*)::int AS n FROM core.correction_request WHERE status IN ('received','under_review','referred_legal')")).rows[0].n;

    send(res, 200, desk(req, "Queue", html`
      <h1>Claim queue</h1>
      <p>Signed in as ${me.displayName} (${me.roles.join(", ")}).
        ${myReview ? html` <strong>${myReview}</strong> claims are waiting for your review.` : ""}
        ${toPublish ? html` <strong>${toPublish}</strong> verified claims are ready to publish.` : ""}
        ${openReports ? html` <a href="/editorial/corrections"><strong>${openReports}</strong> correction reports are open.</a>` : ""}</p>
      <p class="counts"><a href="/editorial"${!status ? html` aria-current="page"` : ""}>All active</a>
        ${STATUSES.map((s) => html`<a href="/editorial?status=${s}">${statusLabel[s]} (${counts.find((c) => c.status === s)?.n ?? 0})</a>`)}</p>
      <form class="filters" method="get" action="/editorial">${status ? html`<input type="hidden" name="status" value="${status}">` : ""}
        <label>Search text or ID<input type="search" name="q" value="${q}"></label><button class="button plain" type="submit">Search</button></form>
      ${list.length === 0 ? html`<p class="quiet">No claims match.</p>` : html`<div class="table-scroll"><table class="desk-table">
        <thead><tr><th>ID</th><th>Status</th><th>Kind</th><th>Subject</th><th>Claim</th><th>Author</th><th>Updated</th></tr></thead>
        <tbody>${list.map((c) => html`<tr>
          <td><a class="ids" href="/editorial/claims/${c.id}">${c.public_id}</a></td>
          <td>${statusLabel[c.status]}${c.attention_reason ? html`<br><strong>Needs attention</strong>` : ""}</td>
          <td>${label(kindLabel, c.kind)}</td><td>${c.subject}</td>
          <td>${c.claim_text.length > 140 ? c.claim_text.slice(0, 140) + "…" : c.claim_text}</td>
          <td>${c.author}${c.author_human ? "" : html`<br><span class="small quiet">automated import</span>`}</td>
          <td>${formatTimestamp(c.updated_at)}</td></tr>`)}</tbody></table></div>`}`, "/editorial"));
  }));

  // ------------------------------------------------------------ New claim
  r.get("/claims/new", wrap(async (req, res) => {
    const kind = oneOf(req.query.kind, [...FACET_KINDS, ...Object.keys(RECORD_SPECS)] as string[]);
    if (!kind) {
      return void send(res, 200, desk(req, "New claim", html`<h1>New claim</h1>
        <p>Every fact starts as a claim. Choose what kind of fact you are recording.</p>
        <h2>Facts about an institution or person</h2>
        <ul>${FACET_KINDS.map((k) => html`<li><a href="/editorial/claims/new?kind=${k}">${kindLabel[k]}</a>${k === "identity" ? html` — required before anything about the entity can be published` : ""}</li>`)}</ul>
        <h2>Structured records</h2>
        <ul>${Object.entries(RECORD_SPECS).map(([k, s]) => html`<li><a href="/editorial/claims/new?kind=${k}">${s.title}</a></li>`)}</ul>`, "/editorial/claims/new"));
    }
    send(res, 200, desk(req, "New claim", await newClaimForm(req, kind, {}, []), "/editorial/claims/new"));
  }));

  async function newClaimForm(req: Request, kind: string, v: Record<string, string>, errors: string[]) {
    const spec = RECORD_SPECS[kind];
    const opts = await entityOptions();
    const extras = await recordExtras();
    return html`<h1>New claim: ${kindLabel[kind] ?? kind}</h1>
      ${errors.length ? html`<div class="notice error" role="alert"><ul class="problems">${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ""}
      ${opts.institutions.length === 0 && opts.people.length === 0 ? html`<div class="notice"><p>Create an <a href="/editorial/entities">institution or person</a> first.</p></div>` : ""}
      <form class="form" method="post" action="/editorial/claims">${csrf(req)}
        <input type="hidden" name="kind" value="${kind}">
        ${spec ? html`<fieldset><legend>${spec.title}</legend>
            ${await Promise.all(spec.fields.map((f) => fieldInput(f, v[f.name] ?? "", opts, extras)))}</fieldset>`
          : html`<label>Subject<select name="subject" required><option value="">Choose…</option>
              ${opts.institutions.map((o) => html`<option value="i:${o.id}"${v.subject === `i:${o.id}` ? html` selected` : ""}>${o.canonical_name} (institution)</option>`)}
              ${opts.people.map((o) => html`<option value="p:${o.id}"${v.subject === `p:${o.id}` ? html` selected` : ""}>${o.canonical_name} (person)</option>`)}</select></label>`}
        <fieldset><legend>Claim</legend>${claimFields(v)}</fieldset>
        <div><button class="button" type="submit">Create draft claim</button></div>
      </form>`;
  }

  r.post("/claims", wrap(async (req, res) => {
    const kind = oneOf(req.body.kind, [...FACET_KINDS, ...Object.keys(RECORD_SPECS)] as string[]);
    if (!kind) return void res.status(400).type("text").send("Unknown claim kind.");
    const claim = parseClaimBody(req.body);
    const spec = RECORD_SPECS[kind];
    const errors: string[] = [];
    if (claim.claim_text.length < 10) errors.push("Claim text must be at least 10 characters.");
    let parsed: ReturnType<typeof parseFields> | null = null;
    let subject: string | null = null;
    if (spec) { parsed = parseFields(spec, req.body); errors.push(...parsed.errors); }
    else { subject = str(req.body.subject, 20); if (!/^[ip]:\d+$/.test(subject)) errors.push("Choose a subject."); }
    const formValues = Object.fromEntries(Object.entries(req.body).map(([k, val]) => [k, typeof val === "string" ? val : ""]));
    if (errors.length) return void send(res, 400, desk(req, "New claim", await newClaimForm(req, kind, formValues, errors)));
    try {
      const id = await withActor({ userId: req.editor!.id, reason: "create claim" }, async (c) => {
        let inst: number | null = null; let person: number | null = null;
        if (spec && parsed) ({ institutionId: inst, personId: person } = await spec.subject(parsed.values, c));
        else if (subject) { const [t, n] = subject.split(":"); if (t === "i") inst = Number(n); else person = Number(n); }
        const row = (await c.query(
          `INSERT INTO core.claim (kind, claim_text, claim_category, subject_institution_id, subject_person_id, temporal_scope, is_sensitive, known_limitations, review_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [kind, claim.claim_text, claim.claim_category, inst, person, claim.temporal_scope, claim.is_sensitive, claim.known_limitations, claim.review_notes])).rows[0];
        if (spec && parsed) await insertRecord(c, spec, row.id, parsed.values);
        return row.id as number;
      });
      res.redirect(303, `/editorial/claims/${id}?msg=created`);
    } catch (err) {
      const m = dbErrorMessage(err); if (!m) throw err;
      send(res, 400, desk(req, "New claim", await newClaimForm(req, kind, formValues, [m])));
    }
  }));

  // ------------------------------------------------------------ Claim detail
  async function claimPage(req: Request, id: number, error?: string) {
    const c = (await db().query(`
      SELECT c.*, u.display_name AS author_name, u.is_human AS author_human,
             i.canonical_name AS inst_name, i.slug AS inst_slug, p.canonical_name AS person_name, p.slug AS person_slug,
             sc.public_id AS supersedes_public_id
      FROM core.claim c JOIN core.app_user u ON u.id = c.created_by
      LEFT JOIN core.institution i ON i.id = c.subject_institution_id LEFT JOIN core.person p ON p.id = c.subject_person_id
      LEFT JOIN core.claim sc ON sc.id = c.supersedes_claim_id WHERE c.id = $1`, [id])).rows[0];
    if (!c) return null;
    const [links, reviews, probsV, probsP, sources] = await Promise.all([
      db().query(`SELECT cs.*, s.public_id AS source_public_id, s.title, s.publisher, s.canonical_url, s.tier, s.source_type, s.accessed_at,
                         s.availability, cu.display_name AS checked_by_name
                  FROM core.claim_source cs JOIN core.source s ON s.id = cs.source_id LEFT JOIN core.app_user cu ON cu.id = cs.checked_by
                  WHERE cs.claim_id = $1 ORDER BY cs.id`, [id]),
      db().query(`SELECT r.*, u.display_name, u.is_human FROM core.review r JOIN core.app_user u ON u.id = r.reviewer_id WHERE r.claim_id = $1 ORDER BY r.id`, [id]),
      db().query("SELECT core.claim_evidence_problems($1, 'verified') AS p", [id]),
      db().query("SELECT core.claim_evidence_problems($1, 'published') AS p", [id]),
      db().query("SELECT id, public_id, title, publisher FROM core.source ORDER BY title LIMIT 500"),
    ]);
    const spec = RECORD_SPECS[c.kind];
    const record = spec ? (await db().query(`SELECT * FROM core.${spec.table} WHERE claim_id = $1`, [id])).rows[0] : null;
    const editable = EDITABLE.has(c.status);
    const me = req.editor!;
    const isReviewer = hasRole(req, "reviewer") && me.isHuman;
    const transitions = (TRANSITIONS[c.status] ?? []).filter((t) => t.role === "editor" || hasRole(req, t.role));
    const opts = spec ? await entityOptions() : null;
    const extras = spec ? await recordExtras() : null;
    const warnings = languageWarnings([c.claim_text, c.known_limitations, record?.description, record?.establishes, record?.role_description, record?.process_description].filter(Boolean).join("\n"));
    const v: Record<string, string> = {
      claim_text: c.claim_text, claim_category: c.claim_category, temporal_scope: c.temporal_scope ?? "",
      is_sensitive: c.is_sensitive ? "1" : "", known_limitations: c.known_limitations ?? "", review_notes: c.review_notes ?? "",
    };
    const subjectLink = c.inst_slug ? `/institutions/${c.inst_slug}` : `/people/${c.person_slug}`;

    return desk(req, c.public_id, html`
      <p class="small"><a href="/editorial">Queue</a></p>
      <h1 class="ids">${c.public_id}: ${kindLabel[c.kind]}</h1>
      <p><span class="stamp">${statusLabel[c.status]}</span>${c.verification_basis ? html` <span class="stamp ${c.verification_basis === "ai" ? "ai" : ""}">${c.verification_basis === "ai" ? "Checked by AI" : "Checked by a person"}</span>` : ""} about <strong>${c.inst_name ?? c.person_name}</strong>.
        Created by ${c.author_name}${c.author_human ? "" : html` <strong>(automated import — must be checked by a human)</strong>`} on ${formatTimestamp(c.created_at)}.
        ${c.status === "published" ? html`<a href="/claims/${c.public_id}">View public page</a>` : ""}</p>
      ${error ? html`<div class="notice error" role="alert"><p>${error}</p></div>` : ""}
      ${c.attention_reason ? html`<div class="notice error"><p><strong>Needs attention:</strong> ${c.attention_reason}</p></div>` : ""}
      ${warnings.length ? html`<div class="notice error"><p><strong>Language check:</strong> ${warnings.join(" ")}</p></div>` : ""}

      <div class="panel"><h2>Readiness</h2>
        <h3>To verify</h3>${probsV.rows[0].p.length ? html`<ul class="problems">${probsV.rows[0].p.map((p: string) => html`<li>${p}</li>`)}</ul>` : html`<p class="ok">All evidence requirements are met.</p>`}
        ${c.status === "pending_review" && c.created_by === me.id ? html`<p class="small quiet">You wrote this claim, so another reviewer must verify it.</p>` : ""}
        <h3>To publish</h3>${probsP.rows[0].p.length ? html`<ul class="problems">${probsP.rows[0].p.map((p: string) => html`<li>${p}</li>`)}</ul>` : html`<p class="ok">Eligible once verified.</p>`}
      </div>

      ${transitions.length ? html`<div class="panel"><h2>Change status</h2>
        <form class="form" method="post" action="/editorial/claims/${c.id}/transition">${csrf(req)}
          <label>Decision notes <span class="hint">Recorded in the review history.</span><textarea name="notes" maxlength="5000"></textarea></label>
          ${transitions.some((t) => t.to === "retracted") && c.published_at ? html`<label>Public correction note <span class="hint">Required to retract a claim that was published. Shown on the corrections page; do not repeat the withdrawn statement.</span><textarea name="public_correction_note" maxlength="2000"></textarea></label>` : ""}
          <div class="actions-row">${transitions.map((t) => html`<button class="button ${t.to === "published" || t.to === "verified" ? "" : "plain"}" type="submit" name="to" value="${t.to}">${t.label}</button>`)}</div>
        </form></div>` : ""}

      <h2>Claim</h2>
      ${editable ? html`<form class="form" method="post" action="/editorial/claims/${c.id}/edit">${csrf(req)}${claimFields(v)}
          <div><button class="button plain" type="submit">Save claim</button></div></form>`
        : html`<p class="claim-text">${c.claim_text}</p>
          <dl class="meta-grid"><dt>Category</dt><dd>${categoryLabel[c.claim_category]}</dd>
            <dt>Applies to</dt><dd>${c.temporal_scope ?? "—"}</dd><dt>Sensitive</dt><dd>${c.is_sensitive ? "Yes" : "No"}</dd>
            <dt>Known limitations</dt><dd>${c.known_limitations ?? "—"}</dd><dt>Internal notes</dt><dd>${c.review_notes ?? "—"}</dd>
            ${c.supersedes_public_id ? html`<dt>Corrects</dt><dd>${c.supersedes_public_id}</dd>` : ""}</dl>
          <p class="small quiet">Content is locked while the claim is ${statusLabel[c.status]?.toLowerCase()}.</p>`}

      ${spec ? html`<h2>${spec.title} record</h2>
        ${!record ? html`<p class="quiet">No record attached.</p>` : editable && opts && extras
          ? html`<form class="form" method="post" action="/editorial/claims/${c.id}/record">${csrf(req)}
              ${await Promise.all(spec.fields.map((f) => fieldInput(f, rowToForm(spec, record)[f.name] ?? "", opts, extras)))}
              <div><button class="button plain" type="submit">Save record</button></div></form>`
          : html`<dl class="meta-grid">${spec.fields.map((f) => html`<dt>${f.label}</dt><dd>${rowToForm(spec, record)[f.name] || "—"}</dd>`)}</dl>`}` : ""}

      <h2>Evidence</h2>
      ${links.rows.length === 0 ? html`<p class="quiet">No sources attached yet.</p>` : html`<div class="table-scroll"><table class="desk-table">
        <thead><tr><th>Source</th><th>Role</th><th>Location and passage</th><th>Human check</th><th></th></tr></thead>
        <tbody>${links.rows.map((l) => html`<tr>
          <td><a href="${safeHref(l.canonical_url)}" rel="noopener noreferrer">${l.title}</a><br>
            <span class="small quiet">${l.source_public_id}. ${l.publisher}. ${tierLabel[l.tier]}. ${label(sourceTypeLabel, l.source_type)}.
            Accessed ${l.accessed_at ? formatDated(l.accessed_at, "day") : "never"}.${l.availability !== "available" ? ` Availability: ${l.availability.replace(/_/g, " ")}.` : ""}</span></td>
          <td>${l.evidence_role}</td>
          <td><strong>${l.relevant_section ?? "No section recorded"}</strong>
            ${l.supporting_excerpt ? html`<blockquote>${l.supporting_excerpt}</blockquote>` : ""}
            ${l.passage_description ? html`<p class="small">${l.passage_description}</p>` : ""}
            ${l.verification_notes ? html`<p class="small quiet">Notes: ${l.verification_notes}</p>` : ""}</td>
          <td>${l.checked_by ? html`Confirmed by ${l.checked_by_name}${l.check_basis === "ai" ? " (AI)" : ""}, ${formatTimestamp(l.checked_at)}` : "Not confirmed"}
            ${(!l.checked_by || l.check_basis === "ai") && editable && isReviewer && l.evidence_role === "supports" ? html`
              <form method="post" action="/editorial/links/${l.id}/confirm">${csrf(req)}
                <label class="check small"><input type="checkbox" name="attest" value="1" required> I opened this source myself and it says what the claim says, at this location.</label>
                <button class="button plain" type="submit">Confirm check</button></form>` : ""}</td>
          <td>${editable ? html`<form method="post" action="/editorial/links/${l.id}/delete">${csrf(req)}<button class="button plain" type="submit">Remove</button></form>` : ""}</td>
        </tr>`)}</tbody></table></div>`}

      ${editable ? html`<div class="panel"><h3>Attach a source</h3>
        <form class="form" method="post" action="/editorial/claims/${c.id}/sources">${csrf(req)}
          <label>Existing source<select name="source_id"><option value="">Create a new source below</option>
            ${sources.rows.map((s) => html`<option value="${s.id}">${s.public_id}: ${s.title} (${s.publisher})</option>`)}</select></label>
          <fieldset><legend>Or a new source</legend>${newSourceFields()}</fieldset>
          <div class="row">
            <label>Role<select name="evidence_role"><option value="supports">Supports</option><option value="contradicts">Contradicts or complicates</option><option value="context">Context</option></select></label>
            <label>Page, article, section or paragraph<input type="text" name="relevant_section" maxlength="300"></label>
          </div>
          <label>Excerpt <span class="hint">Short and exact. Under about 50 words.</span><textarea name="supporting_excerpt" maxlength="600"></textarea></label>
          <label>Or a precise description of the passage<textarea name="passage_description" maxlength="1000"></textarea></label>
          <label>Verification notes <span class="hint">Internal.</span><textarea name="verification_notes" maxlength="3000"></textarea></label>
          <div><button class="button plain" type="submit">Attach source</button></div>
        </form></div>` : ""}

      <h2>Review history</h2>
      ${reviews.rows.length === 0 ? html`<p class="quiet">No status changes yet.</p>` : html`<table class="desk-table"><thead><tr><th>When</th><th>Change</th><th>By</th><th>Notes</th></tr></thead>
        <tbody>${reviews.rows.map((rv) => html`<tr><td>${formatTimestamp(rv.reviewed_at)}</td><td>${statusLabel[rv.from_status]} to ${statusLabel[rv.to_status]}</td>
          <td>${rv.display_name}${rv.is_human ? "" : " (automated)"}</td><td>${rv.notes ?? ""}</td></tr>`)}</tbody></table>`}
      <p class="small"><a href="/editorial/audit?entity=claim&id=${c.id}">Full audit trail</a>
        ${c.status === "published" ? html` · <a href="${subjectLink}">Public profile</a>` : ""}</p>`);
  }

  r.get("/claims/:id", wrap(async (req, res) => {
    const id = int(req.params.id);
    const body = id ? await claimPage(req, id) : null;
    if (!body) return void res.status(404).type("text").send("No such claim.");
    send(res, 200, body);
  }));

  async function claimAction(req: Request, res: Response, fn: (c: pg.PoolClient, id: number) => Promise<void>, msg: string, extra: { reason?: string; notes?: string } = {}) {
    const id = int(req.params.id);
    if (!id) return void res.status(404).type("text").send("No such claim.");
    try {
      await withActor({ userId: req.editor!.id, reason: extra.reason, reviewNotes: extra.notes }, (c) => fn(c, id));
      res.redirect(303, `/editorial/claims/${id}?msg=${msg}`);
    } catch (err) {
      const m = dbErrorMessage(err); if (!m) throw err;
      const body = await claimPage(req, id, m);
      if (!body) return void res.status(404).type("text").send("No such claim.");
      send(res, 409, body);
    }
  }

  r.post("/claims/:id/edit", wrap(async (req, res) => {
    const v = parseClaimBody(req.body);
    await claimAction(req, res, async (c, id) => {
      await c.query(`UPDATE core.claim SET claim_text=$2, claim_category=$3, temporal_scope=$4, is_sensitive=$5, known_limitations=$6, review_notes=$7 WHERE id=$1`,
        [id, v.claim_text, v.claim_category, v.temporal_scope, v.is_sensitive, v.known_limitations, v.review_notes]);
    }, "saved", { reason: "edit claim" });
  }));

  r.post("/claims/:id/record", wrap(async (req, res) => {
    const id = int(req.params.id);
    const kind = id ? (await db().query("SELECT kind FROM core.claim WHERE id = $1", [id])).rows[0]?.kind : null;
    const spec = kind ? RECORD_SPECS[kind] : undefined;
    if (!spec) return void res.status(400).type("text").send("This claim has no structured record.");
    const parsed = parseFields(spec, req.body);
    if (parsed.errors.length) {
      const body = await claimPage(req, id!, parsed.errors.join(" "));
      return void send(res, 400, body!);
    }
    await claimAction(req, res, (c, cid) => updateRecord(c, spec, cid, parsed.values), "saved", { reason: "edit record" });
  }));

  r.post("/claims/:id/transition", wrap(async (req, res) => {
    const to = oneOf(req.body.to, STATUSES);
    if (!to) return void res.status(400).type("text").send("Unknown status.");
    const note = optStr(req.body.public_correction_note, 2000);
    await claimAction(req, res, async (c, id) => {
      if (note) await c.query("UPDATE core.claim SET public_correction_note = $2 WHERE id = $1", [id, note]);
      await c.query("UPDATE core.claim SET status = $2 WHERE id = $1", [id, to]);
    }, "transitioned", { reason: `status → ${to}`, notes: str(req.body.notes, 5000) });
  }));

  r.post("/claims/:id/sources", wrap(async (req, res) => {
    const role = oneOf(req.body.evidence_role, ["supports", "contradicts", "context"] as const) ?? "supports";
    let sourceId = int(req.body.source_id);
    let newSource: ReturnType<typeof parseSourceBody> | null = null;
    if (!sourceId) {
      newSource = parseSourceBody(req.body);
      if ("error" in newSource) { const body = await claimPage(req, int(req.params.id)!, newSource.error); return void send(res, 400, body!); }
    }
    await claimAction(req, res, async (c, id) => {
      if (!sourceId && newSource && !("error" in newSource)) sourceId = await insertSource(c, newSource);
      await c.query(`INSERT INTO core.claim_source (claim_id, source_id, evidence_role, relevant_section, supporting_excerpt, passage_description, verification_notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, sourceId, role, optStr(req.body.relevant_section, 300), optStr(req.body.supporting_excerpt, 600),
        optStr(req.body.passage_description, 1000), optStr(req.body.verification_notes, 3000)]);
    }, "linked", { reason: "attach source" });
  }));

  const linkAction = (sql: string, msg: string, reason: string, check?: (req: Request) => string | null) => wrap(async (req, res) => {
    const linkId = int(req.params.id);
    const claimId = linkId ? (await db().query("SELECT claim_id FROM core.claim_source WHERE id = $1", [linkId])).rows[0]?.claim_id : null;
    if (!claimId) return void res.status(404).type("text").send("No such link.");
    const problem = check?.(req);
    if (problem) { const body = await claimPage(req, Number(claimId), problem); return void send(res, 400, body!); }
    req.params.id = String(claimId);
    await claimAction(req, res, async (c) => { await c.query(sql, [linkId, req.editor!.id]); }, msg, { reason });
  });
  r.post("/links/:id/confirm", linkAction("UPDATE core.claim_source SET checked_by = $2 WHERE id = $1", "confirmed", "confirm source check",
    (req) => req.body.attest === "1" ? null : "Tick the box to confirm you opened the source yourself."));
  r.post("/links/:id/delete", linkAction("DELETE FROM core.claim_source WHERE id = $1 AND $2::int IS NOT NULL", "unlinked", "remove source link"));

  // ------------------------------------------------------------ Sources
  function newSourceFields() {
    return html`<label>Title<input type="text" name="s_title" maxlength="400"></label>
      <div class="row"><label>Publisher<input type="text" name="s_publisher" maxlength="200"></label>
        <label>Source type<select name="s_type"><option value="">Choose…</option>${SOURCE_TYPES.map((t) => html`<option value="${t}">${sourceTypeLabel[t]}</option>`)}</select></label></div>
      <label>Canonical URL<input type="url" name="s_url" maxlength="2000" placeholder="https://"></label>
      <div class="row"><label>Publication date <span class="hint">YYYY, YYYY-MM or YYYY-MM-DD</span><input type="text" name="s_pubdate" maxlength="10"></label>
        <label>Date you accessed it <span class="hint">Leave empty if not yet opened.</span><input type="date" name="s_accessed"></label></div>
      <div class="row"><label>Document identifier <span class="hint">Act no., notification no., case no.</span><input type="text" name="s_docid" maxlength="200"></label>
        <label>Version <span class="hint">e.g. as amended up to …</span><input type="text" name="s_version" maxlength="200"></label></div>
      <label>Archived copy URL <span class="hint">Optional</span><input type="url" name="s_archive" maxlength="2000"></label>`;
  }

  function parseSourceBody(b: Record<string, unknown>) {
    const title = str(b.s_title, 400), publisher = str(b.s_publisher, 200), url = str(b.s_url, 2000);
    const type = oneOf(b.s_type, SOURCE_TYPES);
    const archive = optStr(b.s_archive, 2000);
    const accessed = optStr(b.s_accessed, 10);
    if (!title || !publisher || !type) return { error: "A new source needs a title, publisher and type." } as const;
    if (!isHttpUrl(url)) return { error: "The source URL must be a full http(s) address." } as const;
    if (archive && !isHttpUrl(archive)) return { error: "The archived copy URL must be a full http(s) address." } as const;
    if (accessed && !/^\d{4}-\d{2}-\d{2}$/.test(accessed)) return { error: "Access date must be YYYY-MM-DD." } as const;
    const pub = parseDated(b.s_pubdate);
    if ("error" in pub) return { error: `Publication date: ${pub.error}` } as const;
    return { title, publisher, url, type, archive, accessed, pub, docid: optStr(b.s_docid, 200), version: optStr(b.s_version, 200) };
  }

  async function insertSource(c: pg.PoolClient, s: Exclude<ReturnType<typeof parseSourceBody>, { error: string }>) {
    return (await c.query(`INSERT INTO core.source (title, publisher, canonical_url, source_type, publication_date, publication_precision,
        accessed_at, document_identifier, document_version, archived_url, availability)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $7::date IS NULL THEN 'unknown' ELSE 'available' END::core.source_availability) RETURNING id`,
      [s.title, s.publisher, s.url, s.type, s.pub.date, s.pub.precision, s.accessed, s.docid, s.version, s.archive])).rows[0].id as number;
  }

  r.get("/sources", wrap(async (req, res) => {
    const q = str(req.query.q, 100);
    const rows = (await db().query(`SELECT s.*, (SELECT count(*) FROM core.claim_source cs WHERE cs.source_id = s.id)::int AS uses
      FROM core.source s WHERE $1 = '' OR s.title ILIKE '%' || $1 || '%' OR s.publisher ILIKE '%' || $1 || '%' OR s.public_id = $1
      ORDER BY s.created_at DESC LIMIT 300`, [q])).rows;
    send(res, 200, desk(req, "Sources", html`<h1>Sources</h1>
      <form class="filters" method="get"><label>Search<input type="search" name="q" value="${q}"></label><button class="button plain" type="submit">Search</button></form>
      <div class="table-scroll"><table class="desk-table"><thead><tr><th>ID</th><th>Source</th><th>Tier</th><th>Accessed</th><th>Used by</th><th>Availability</th></tr></thead>
      <tbody>${rows.map((s) => html`<tr><td class="ids">${s.public_id}</td>
        <td><a href="${safeHref(s.canonical_url)}" rel="noopener noreferrer">${s.title}</a><br><span class="small quiet">${s.publisher}. ${label(sourceTypeLabel, s.source_type)}${s.document_identifier ? `. ${s.document_identifier}` : ""}</span></td>
        <td>${s.tier}</td><td>${s.accessed_at ? formatDated(s.accessed_at, "day") : "Never"}</td><td>${s.uses}</td>
        <td><form method="post" action="/editorial/sources/${s.id}/availability">${csrf(req)}
          <select name="availability" aria-label="Availability">${["available", "unavailable", "changed_since_access", "unknown"].map((a) => html`<option value="${a}"${a === s.availability ? html` selected` : ""}>${a.replace(/_/g, " ")}</option>`)}</select>
          <button class="button plain" type="submit">Update</button></form></td></tr>`)}</tbody></table></div>
      <div class="panel"><h2>New source</h2><form class="form" method="post" action="/editorial/sources">${csrf(req)}${newSourceFields()}
        <div><button class="button" type="submit">Create source</button></div></form></div>`, "/editorial/sources"));
  }));

  r.post("/sources", wrap(async (req, res) => {
    const s = parseSourceBody(req.body);
    if ("error" in s) return void res.status(400).type("text").send(s.error);
    try {
      await withActor({ userId: req.editor!.id, reason: "create source" }, (c) => insertSource(c, s));
      res.redirect(303, "/editorial/sources?msg=source_created");
    } catch (err) { const m = dbErrorMessage(err); if (!m) throw err; res.status(400).type("text").send(m); }
  }));

  r.post("/sources/:id/availability", wrap(async (req, res) => {
    const id = int(req.params.id);
    const a = oneOf(req.body.availability, ["available", "unavailable", "changed_since_access", "unknown"] as const);
    if (!id || !a) return void res.status(400).type("text").send("Invalid request.");
    await withActor({ userId: req.editor!.id, reason: "source availability" }, (c) => c.query("UPDATE core.source SET availability = $2 WHERE id = $1", [id, a]));
    res.redirect(303, "/editorial/sources?msg=availability");
  }));

  // ------------------------------------------------------------ Entities
  r.get("/entities", wrap(async (req, res) => {
    const insts = (await db().query(`SELECT i.*, (SELECT string_agg(c.status::text, ', ') FROM core.claim c WHERE c.kind='identity' AND c.subject_institution_id=i.id) AS identity
      FROM core.institution i ORDER BY canonical_name`)).rows;
    const people = (await db().query(`SELECT p.*, (SELECT string_agg(c.status::text, ', ') FROM core.claim c WHERE c.kind='identity' AND c.subject_person_id=p.id) AS identity
      FROM core.person p ORDER BY canonical_name`)).rows;
    send(res, 200, desk(req, "Entities", html`<h1>Entities</h1>
      <p>An entity becomes public only when its identity claim is published. Creating an entity here publishes nothing.</p>
      <h2>Institutions and bodies</h2>
      <table class="desk-table"><thead><tr><th>Name</th><th>Category</th><th>Type</th><th>Identity claim</th></tr></thead>
        <tbody>${insts.map((i) => html`<tr><td>${i.canonical_name}<br><span class="small quiet">${i.slug}</span></td><td>${label(legalCategoryLabel, i.legal_category)}</td>
          <td>${label(entityKindLabel, i.entity_kind)}</td><td>${i.identity ?? html`<a href="/editorial/claims/new?kind=identity">None — create one</a>`}</td></tr>`)}</tbody></table>
      <div class="panel"><h3>New institution or body</h3><form class="form" method="post" action="/editorial/institutions">${csrf(req)}
        <label>Official name<input type="text" name="canonical_name" required maxlength="200"></label>
        <div class="row"><label>Short name <span class="hint">Optional, e.g. ECI</span><input type="text" name="short_name" maxlength="40"></label>
          <label>Official website<input type="url" name="official_website" maxlength="2000"></label></div>
        <div class="row"><label>Legal category<select name="legal_category" required>${Object.entries(legalCategoryLabel).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
          <label>Type<select name="entity_kind" required>${Object.entries(entityKindLabel).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label></div>
        <div><button class="button" type="submit">Create institution</button></div></form></div>
      <h2>People</h2>
      <table class="desk-table"><thead><tr><th>Name</th><th>Identity claim</th></tr></thead>
        <tbody>${people.map((p) => html`<tr><td>${p.canonical_name}<br><span class="small quiet">${p.slug}</span></td><td>${p.identity ?? html`<a href="/editorial/claims/new?kind=identity">None — create one</a>`}</td></tr>`)}</tbody></table>
      <div class="panel"><h3>New person</h3>
        <p class="small quiet">Only public officeholders and people whose documented public role is relevant. Use the full name as given in an authoritative source.</p>
        <form class="form" method="post" action="/editorial/people">${csrf(req)}
        <label>Full name<input type="text" name="canonical_name" required maxlength="200"></label>
        <div><button class="button" type="submit">Create person</button></div></form></div>`, "/editorial/entities"));
  }));

  r.post("/institutions", wrap(async (req, res) => {
    const name = str(req.body.canonical_name, 200);
    const site = optStr(req.body.official_website, 2000);
    const cat = oneOf(req.body.legal_category, Object.keys(legalCategoryLabel));
    const kind = oneOf(req.body.entity_kind, Object.keys(entityKindLabel));
    if (name.length < 2 || !cat || !kind) return void res.status(400).type("text").send("Name, legal category and type are required.");
    if (site && !isHttpUrl(site)) return void res.status(400).type("text").send("Website must be a full http(s) address.");
    try {
      await withActor({ userId: req.editor!.id, reason: "create institution" }, (c) => c.query(
        "INSERT INTO core.institution (slug, canonical_name, short_name, official_website, legal_category, entity_kind) VALUES ($1,$2,$3,$4,$5,$6)",
        [slugify(name), name, optStr(req.body.short_name, 40), site, cat, kind]));
      res.redirect(303, "/editorial/entities?msg=entity_created");
    } catch (err) { const m = dbErrorMessage(err); if (!m) throw err; res.status(400).type("text").send(m); }
  }));

  r.post("/people", wrap(async (req, res) => {
    const name = str(req.body.canonical_name, 200);
    if (name.length < 2) return void res.status(400).type("text").send("Name is required.");
    try {
      await withActor({ userId: req.editor!.id, reason: "create person" }, (c) => c.query(
        "INSERT INTO core.person (slug, canonical_name) VALUES ($1,$2)", [slugify(name), name]));
      res.redirect(303, "/editorial/entities?msg=entity_created");
    } catch (err) { const m = dbErrorMessage(err); if (!m) throw err; res.status(400).type("text").send(m); }
  }));

  // ------------------------------------------------------------ Correction reports
  const CSTATUS = ["received", "under_review", "referred_legal", "resolved_corrected", "resolved_no_change", "rejected"] as const;
  r.get("/corrections", wrap(async (req, res) => {
    const rows = (await db().query("SELECT * FROM core.correction_request ORDER BY (status IN ('received','under_review','referred_legal')) DESC, created_at DESC LIMIT 300")).rows;
    send(res, 200, desk(req, "Correction reports", html`<h1>Correction reports</h1>
      <p>Reports are private. Resolve each by re-checking the claim; take it down first if there is reasonable doubt. Refer anything involving defamation or privacy for legal review.</p>
      ${rows.length === 0 ? html`<p class="quiet">No reports.</p>` : rows.map((c) => html`<div class="panel">
        <h3 class="ids">${c.public_ref} ${c.claim_public_id ? html`about <a href="/editorial?q=${c.claim_public_id}">${c.claim_public_id}</a>` : ""}</h3>
        <p class="small quiet">${formatTimestamp(c.created_at)}${c.page_path ? ` · ${c.page_path}` : ""}${c.submitter_name ? ` · from ${c.submitter_name}` : ""}${c.submitter_contact ? ` (${c.submitter_contact})` : ""}</p>
        <p>${c.message}</p>
        <form class="form" method="post" action="/editorial/corrections/${c.id}">${csrf(req)}
          <div class="row"><label>Status<select name="status">${CSTATUS.map((s) => html`<option value="${s}"${s === c.status ? html` selected` : ""}>${s.replace(/_/g, " ")}</option>`)}</select></label></div>
          <label>Resolution notes<textarea name="resolution_notes" maxlength="5000">${c.resolution_notes ?? ""}</textarea></label>
          <div><button class="button plain" type="submit">Save</button></div></form></div>`)}`, "/editorial/corrections"));
  }));
  r.post("/corrections/:id", wrap(async (req, res) => {
    const id = int(req.params.id); const s = oneOf(req.body.status, CSTATUS);
    if (!id || !s) return void res.status(400).type("text").send("Invalid request.");
    await withActor({ userId: req.editor!.id, reason: "correction report" }, (c) => c.query(
      "UPDATE core.correction_request SET status = $2, resolution_notes = $3, updated_at = now() WHERE id = $1", [id, s, optStr(req.body.resolution_notes, 5000)]));
    res.redirect(303, "/editorial/corrections?msg=correction_saved");
  }));

  // ------------------------------------------------------------ Audit log
  r.get("/audit", wrap(async (req, res) => {
    const entity = str(req.query.entity, 40); const id = str(req.query.id, 20);
    const rows = (await db().query(`SELECT a.*, u.username FROM core.audit_log a LEFT JOIN core.app_user u ON u.id = a.changed_by
      WHERE ($1 = '' OR a.entity_type = $1) AND ($2 = '' OR a.entity_id = $2) ORDER BY a.id DESC LIMIT 200`, [entity, id])).rows;
    const diff = (p: Record<string, unknown> | null, n: Record<string, unknown> | null) => {
      if (!p || !n) return "";
      return Object.keys(n).filter((k) => JSON.stringify(p[k]) !== JSON.stringify(n[k]) && k !== "updated_at")
        .map((k) => `${k}: ${JSON.stringify(p[k])?.slice(0, 80)} → ${JSON.stringify(n[k])?.slice(0, 80)}`).join("; ");
    };
    send(res, 200, desk(req, "Audit log", html`<h1>Audit log</h1><p>Append-only. The most recent 200 entries${entity ? ` for ${entity}${id ? ` ${id}` : ""}` : ""}.</p>
      <div class="table-scroll"><table class="desk-table"><thead><tr><th>When</th><th>Who</th><th>Entity</th><th>Action</th><th>Change</th><th>Reason</th></tr></thead>
      <tbody>${rows.map((a) => html`<tr><td>${new Date(a.changed_at).toISOString().replace("T", " ").slice(0, 19)}</td><td>${a.username ?? "system"}</td>
        <td>${a.entity_type} ${a.entity_id}</td><td>${a.action}</td><td class="small">${a.action === "update" ? diff(a.previous_value, a.new_value) : ""}</td><td>${a.reason ?? ""}</td></tr>`)}</tbody></table></div>`, "/editorial/audit"));
  }));

  // ------------------------------------------------------------ Users (admin)
  r.get("/users", requireRole("admin"), wrap(async (req, res) => {
    const users = (await db().query("SELECT id, username, display_name, roles::text[] AS roles, is_human, active, public_role_label FROM core.app_user ORDER BY id")).rows;
    const roleBoxes = (current: string[]) => ROLES.map((r) => html`<label class="check"><input type="checkbox" name="roles" value="${r}"${current.includes(r) ? html` checked` : ""}> ${r}</label>`);
    send(res, 200, desk(req, "Users", html`<h1>Editorial users</h1>
      <p>Separate the roles where you can. Verification always requires a reviewer other than the claim's author. Automated accounts cannot review or publish.</p>
      ${users.map((u) => html`<div class="panel"><h3>${u.display_name} <span class="small quiet">${u.username}${u.is_human ? "" : " — automated account"}${u.active ? "" : " — inactive"}</span></h3>
        ${u.is_human ? html`<form class="form" method="post" action="/editorial/users/${u.id}">${csrf(req)}
          <fieldset><legend>Roles</legend>${roleBoxes(u.roles)}</fieldset>
          <label class="check"><input type="checkbox" name="active" value="1"${u.active ? html` checked` : ""}> Active</label>
          <label>New password <span class="hint">Leave empty to keep. At least 12 characters.</span><input type="password" name="password" autocomplete="new-password" maxlength="200"></label>
          <div><button class="button plain" type="submit">Save user</button></div></form>` : html`<p class="small">Roles: ${u.roles.join(", ")}</p>`}</div>`)}
      <div class="panel"><h2>New user</h2><form class="form" method="post" action="/editorial/users">${csrf(req)}
        <div class="row"><label>Username<input type="text" name="username" required pattern="[a-z0-9_.\\-]{3,40}" maxlength="40"></label>
          <label>Display name<input type="text" name="display_name" required maxlength="120"></label></div>
        <fieldset><legend>Roles</legend>${roleBoxes(["researcher"])}</fieldset>
        <label>Password <span class="hint">At least 12 characters.</span><input type="password" name="password" required minlength="12" autocomplete="new-password" maxlength="200"></label>
        <div><button class="button" type="submit">Create user</button></div></form></div>`, "/editorial/users"));
  }));

  const parseRoles = (v: unknown) => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && (ROLES as readonly string[]).includes(x));

  r.post("/users", requireRole("admin"), wrap(async (req, res) => {
    const username = str(req.body.username, 40).toLowerCase();
    const pw = str(req.body.password, 200);
    if (!/^[a-z0-9_.-]{3,40}$/.test(username) || pw.length < 12) return void res.status(400).type("text").send("Username must be 3–40 lowercase characters and password at least 12 characters.");
    const hash = await hashPassword(pw);
    try {
      await withActor({ userId: req.editor!.id, reason: "create user" }, (c) => c.query(
        "INSERT INTO core.app_user (username, display_name, roles, password_hash) VALUES ($1,$2,$3::core.user_role[],$4)",
        [username, str(req.body.display_name, 120) || username, parseRoles(req.body.roles), hash]));
      res.redirect(303, "/editorial/users?msg=user_saved");
    } catch (err) { const m = dbErrorMessage(err); if (!m) throw err; res.status(400).type("text").send(m); }
  }));

  r.post("/users/:id", requireRole("admin"), wrap(async (req, res) => {
    const id = int(req.params.id);
    if (!id) return void res.status(400).type("text").send("Invalid user.");
    const pw = str(req.body.password, 200);
    if (pw && pw.length < 12) return void res.status(400).type("text").send("Passwords must be at least 12 characters.");
    const hash = pw ? await hashPassword(pw) : null;
    try {
      await withActor({ userId: req.editor!.id, reason: "update user" }, async (c) => {
        await c.query("UPDATE core.app_user SET roles = $2::core.user_role[], active = $3, password_hash = coalesce($4, password_hash) WHERE id = $1",
          [id, parseRoles(req.body.roles), req.body.active === "1", hash]);
        if (hash || req.body.active !== "1") await c.query("DELETE FROM core.session WHERE user_id = $1 AND user_id <> $2", [id, req.editor!.id]);
      });
      res.redirect(303, "/editorial/users?msg=user_saved");
    } catch (err) { const m = dbErrorMessage(err); if (!m) throw err; res.status(400).type("text").send(m); }
  }));

  return r;
}
