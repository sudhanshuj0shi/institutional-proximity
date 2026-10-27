import { Router, type Request, type Response, type NextFunction } from "express";
import { html, jsonForScript, SafeHtml } from "../lib/html.js";
import { page } from "../lib/layout.js";
import { formatRange, formatTimestamp, sortKey } from "../lib/dates.js";
import {
  categoryLabel, entityKindLabel, kindLabel, label, legalCategoryLabel, relationshipLabel,
  relationshipMeaning, RELATIONSHIP_TYPES,
} from "../lib/labels.js";
import * as Q from "./queries.js";
import { basisTag, emptyState, groupEvidence, sourceEntry } from "./components.js";
import { appointmentPage, institutionProfile, loadInstitution, relationshipsList } from "./institution-pages.js";
import { buildGraph } from "./graph.js";
import { methodologyBody } from "./methodology.js";
import { loadVizData } from "./visual-data.js";
import { appointmentWeb, safeguardMatrix, statStrip, timeline, vizData } from "./visuals.js";
import { rateLimit } from "../lib/security.js";
import { setSiteNotice } from "../lib/layout.js";
import { str } from "../lib/validate.js";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CLAIM_ID = /^C-\d{6}$/;
type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

function send(res: Response, status: number, body: SafeHtml) {
  res.status(status).type("html").send(body.value);
}

export function notFound(res: Response, editorial: Request["editor"] | null = null) {
  send(res, 404, page({
    title: "Page not found", description: "This page does not exist.", path: "/404", noindex: true, editorial,
    body: html`<div class="wrap"><h1>Page not found</h1>
      <p class="lede">There is no published record at this address. Unpublished or unverified records are never shown.</p>
      <p><a href="/institutions">Browse institutions</a></p></div>`,
  }));
}

async function loadGraph() {
  const [institutions, people, positions, relationships] = await Promise.all([
    Q.listInstitutions(), Q.listPeople(), Q.allPositions(), Q.allRelationships(),
  ]);
  const checkedBy = await Q.basisFor([...positions.map((p) => p.claim_id), ...relationships.map((r) => r.claim_id)]);
  return buildGraph({ institutions, people, positions, relationships, checkedBy });
}

function legendSvg(stroke: string): SafeHtml {
  const dash: Record<string, string> = { solid: "", dash: "6 4", dot: "1.5 4", dashdot: "8 3 2 3", longdash: "12 4", double: "" };
  const d = dash[stroke] ?? "";
  if (stroke === "double") {
    return html`<svg width="40" height="12" aria-hidden="true"><line x1="0" y1="3.5" x2="40" y2="3.5" stroke="currentColor" stroke-width="1.5"/><line x1="0" y1="8.5" x2="40" y2="8.5" stroke="currentColor" stroke-width="1.5"/></svg>`;
  }
  return html`<svg width="40" height="12" aria-hidden="true"><line x1="0" y1="6" x2="40" y2="6" stroke="currentColor" stroke-width="2" ${d ? html`stroke-dasharray="${d}"` : ""} stroke-linecap="round"/></svg>`;
}

export function publicRouter(): Router {
  const r = Router();

  // Site-wide disclosure banner whenever AI-checked claims are published (cached briefly).
  let noticeCheckedAt = 0;
  r.use(async (_req, _res, next) => {
    if (Date.now() - noticeCheckedAt > 30_000) {
      try {
        const s = await Q.siteStatus();
        noticeCheckedAt = Date.now();
        const ai = Number(s.published_ai_checked ?? 0);
        setSiteNotice(ai > 0 ? { ai, total: Number(s.published_claims) } : null);
      } catch { /* the page itself will surface DB errors */ }
    }
    next();
  });

  // ---------------------------------------------------------------- Home (visual first)
  r.get("/", wrap(async (req, res) => {
    const [status, viz] = await Promise.all([Q.siteStatus(), loadVizData()]);
    const independents = viz.institutions.filter((i) => i.kind === "independent_institution");
    const slugs = independents.map((i) => i.slug);
    const published = Number(status.published_claims);
    const aiShare = published ? Math.round((Number(status.published_ai_checked) / published) * 100) : 0;
    send(res, 200, page({
      title: "Institutional Proximity", path: "/", section: "home", editorial: req.editor,
      description: "Who appoints India's independent institutions, and what protects them, drawn from the law with every line sourced.",
      scripts: ["/static/js/viz.js"],
      body: html`${vizData(viz)}<div class="wrap-wide">
        <header class="hero-v">
          <div>
            <h1>Institutional Proximity</h1>
            <p>Who appoints India's independent institutions, and what protects them. Drawn from the law, every line sourced.</p>
          </div>
          ${statStrip([
            { value: published, label: "published claims" },
            { value: independents.length, label: "institutions" },
            { value: `${aiShare}%`, label: "checked by AI so far" },
          ])}
        </header>

        ${published === 0 ? emptyState("Nothing is published yet",
            "Visuals appear here as claims are checked against their sources. Nothing is drawn from inferred or sample data.") : html`
        <section class="vsec" aria-labelledby="h-web">
          <div class="vsec-head"><h2 id="h-web">Who appoints whom</h2><a href="/map">Full relationship map</a></div>
          ${appointmentWeb(viz)}
        </section>

        <section class="vsec" aria-labelledby="h-sg">
          <div class="vsec-head"><h2 id="h-sg">Safeguards side by side</h2></div>
          ${safeguardMatrix(viz, slugs)}
        </section>

        <section class="vsec" aria-labelledby="h-tl">
          <div class="vsec-head"><h2 id="h-tl">Laws, judgments and tenures</h2></div>
          ${timeline(viz, { id: "home-tl", institutions: slugs })}
        </section>

        <section class="vsec" aria-labelledby="h-inst">
          <div class="vsec-head"><h2 id="h-inst">Explore an institution</h2><a href="/institutions">All institutions</a></div>
          <div class="inst-cards">${independents.map((i) => {
            const stages = viz.stages.filter((s) => s.institution === i.slug && s.process === (viz.stages.find((x) => x.institution === i.slug)?.process));
            const sg = viz.safeguards.filter((s) => s.institution === i.slug).length;
            const ten = viz.tenures.filter((t) => t.institution === i.slug).length;
            return html`<a class="inst-card" href="/institutions/${i.slug}">
              <span class="cat">${i.category}</span>
              <h3>${i.name}</h3>
              ${stages.length ? html`<span class="mini-flow" aria-label="${stages.length}-stage appointment process">${stages.map((st, n) => html`${n ? html`<span class="bar"></span>` : ""}<span class="dot" title="${st.title}">${st.seq}</span>`)}<span>&nbsp;${stages.length}-stage appointment</span></span>` : ""}
              <span class="counts"><span><strong>${sg}</strong>safeguards</span><span><strong>${ten}</strong>tenures</span></span>
            </a>`;
          })}</div>
        </section>`}

        <p class="viz-caption vsec">A documented relationship, such as an appointment by the President, describes structure. It is not evidence of political influence. <a href="/methodology">How we check</a></p>
      </div>`,
    }));
  }));

  // ---------------------------------------------------------------- Directory
  r.get("/institutions", wrap(async (req, res) => {
    const q = str(req.query.q, 100);
    const category = str(req.query.category, 40);
    const [institutions, coverage, mandates, processes] = await Promise.all([
      Q.listInstitutions({ q: q || undefined, category: category && legalCategoryLabel[category] ? category : undefined }),
      Q.allCoverage(), Q.mandateClaims(), Q.allProcesses(),
    ]);
    const all = await Q.listInstitutions();
    const categories = [...new Set(all.map((i) => i.legal_category))];
    send(res, 200, page({
      title: "Institutions", path: "/institutions", section: "institutions", editorial: req.editor,
      description: "Directory of researched Indian public institutions, with legal category, mandate, appointment mechanism and verification coverage.",
      body: html`<div class="wrap">
        <h1>Institutions</h1>
        <p class="lede">Each profile is built from verified records only. Constitutional, statutory and executive bodies are kept distinct, because their legal frameworks differ.</p>
        <form class="filters" method="get" action="/institutions" role="search">
          <label>Search by name<input type="search" name="q" value="${q}" placeholder="e.g. Election Commission"></label>
          <label>Legal category<select name="category"><option value="">All categories</option>
            ${categories.map((c) => html`<option value="${c}"${c === category ? html` selected` : ""}>${label(legalCategoryLabel, c)}</option>`)}</select></label>
          <button class="button plain" type="submit">Apply filters</button>
        </form>
        ${institutions.length === 0
          ? (all.length === 0
            ? emptyState("No institution profiles are published yet", "Profiles appear here once the institution's identity, legal basis and mandate have been checked against primary sources.")
            : emptyState("No institutions match these filters", html`Try a different name, or <a href="/institutions">clear the filters</a>.`))
          : html`<ul class="directory">${institutions.map((i) => {
              const cov = coverage.find((c) => c.slug === i.slug);
              const m = mandates.find((c) => c.institution_slug === i.slug);
              const p = processes.filter((pp) => pp.institution_slug === i.slug && !pp.effective_until);
              return html`<li><div>
                <h3><a href="/institutions/${i.slug}">${i.canonical_name}</a></h3>
                ${m ? html`<p>${m.claim_text} <a class="small sans" href="/claims/${m.public_id}">${m.public_id}</a></p>` : html`<p class="quiet small sans">Mandate not yet verified.</p>`}
                </div>
                <dl class="facts-list">
                  <dt>Legal category</dt><dd>${label(legalCategoryLabel, i.legal_category)}</dd>
                  <dt>Type</dt><dd>${label(entityKindLabel, i.entity_kind)}</dd>
                  <dt>Appointment</dt><dd>${p.length ? p.map((pp) => pp.legal_basis).join("; ") : "Not yet verified"}</dd>
                  <dt>Coverage</dt><dd>${cov?.published ?? 0} published, ${cov?.in_progress ?? 0} in progress</dd>
                  <dt>Last verified</dt><dd>${formatTimestamp(i.last_verified_at)}</dd>
                </dl></li>`;
            })}</ul>`}
      </div>`,
    }));
  }));

  // ---------------------------------------------------------------- Institution profile
  r.get("/institutions/:slug", wrap(async (req, res) => {
    const slug = String(req.params.slug);
    if (!SLUG.test(slug)) return notFound(res, req.editor);
    const d = await loadInstitution(slug);
    if (!d) return notFound(res, req.editor);
    const viz = await loadVizData();
    send(res, 200, page({
      title: `${d.inst.canonical_name} — Institutional Profile`, path: req.path, section: "institutions", editorial: req.editor,
      description: `Verified legal basis, appointment process, safeguards, officeholders and legal history of the ${d.inst.canonical_name}, with sources.`,
      body: institutionProfile(d, viz),
      scripts: ["/static/js/viz.js"],
    }));
  }));

  r.get("/institutions/:slug/appointment", wrap(async (req, res) => {
    const slug = String(req.params.slug);
    if (!SLUG.test(slug)) return notFound(res, req.editor);
    const d = await loadInstitution(slug);
    if (!d) return notFound(res, req.editor);
    send(res, 200, page({
      title: `Appointment Process — ${d.inst.canonical_name}`, path: req.path, section: "institutions", editorial: req.editor,
      description: `The legally defined process for appointing officeholders of the ${d.inst.canonical_name}, stage by stage, with the provision behind each stage.`,
      body: appointmentPage(d),
    }));
  }));

  // ---------------------------------------------------------------- Person
  r.get("/people/:slug", wrap(async (req, res) => {
    const slug = String(req.params.slug);
    if (!SLUG.test(slug)) return notFound(res, req.editor);
    const person = await Q.getPerson(slug);
    if (!person) return notFound(res, req.editor);
    const [claims, positions, relationships] = await Promise.all([
      Q.claimsForPerson(slug), Q.positionsForPerson(person.id), Q.relationshipsFor("person", person.id),
    ]);
    const evidence = await Q.evidenceFor([...claims.map((c) => c.public_id), ...positions.map((p) => p.claim_id)]);
    const ev = groupEvidence(evidence);
    const basis = await Q.basisFor([...positions.map((p) => p.claim_id), ...relationships.map((x) => x.claim_id)]);
    const sorted = [...positions].sort((a, b) => sortKey(a.start_date).localeCompare(sortKey(b.start_date)));
    const viz = await loadVizData();
    send(res, 200, page({
      title: `Documented Career History — ${person.canonical_name}`, path: req.path, editorial: req.editor,
      description: `Verified public positions and documented professional relationships of ${person.canonical_name}, each linked to its source.`,
      scripts: ["/static/js/viz.js"],
      body: html`${vizData(viz)}<div class="wrap-wide">
        <header class="hero-v"><div>
          <h1>${person.canonical_name}</h1>
          <p>Public positions documented with sources. Last checked ${formatTimestamp(person.last_verified_at)}.</p>
        </div>${statStrip([{ value: positions.length, label: "documented positions" }])}</header>

        <section class="vsec" aria-labelledby="h-chart"><div class="vsec-head"><h2 id="h-chart">Documented tenures</h2>
          <p>Select a bar for its source. A later appointment is part of the public record, not evidence of a reward or arrangement.</p></div>
          ${timeline(viz, { id: "person-tl", person: person.slug })}</section>

        <section class="vsec" aria-labelledby="h-facts"><div class="vsec-head"><h2 id="h-facts">The record</h2></div>
          <div class="fact-cards">${[...claims.filter((c) => !["position", "relationship"].includes(c.kind)), ...sorted.map((p) => ({ public_id: p.claim_id, claim_text: "", kind: "position", known_limitations: null, verification_basis: basis.get(p.claim_id) ?? null, title: `${p.title}, ${p.institution_name}`, when: formatRange(p.start_date, p.start_precision, p.end_date, p.end_precision, p.ongoing_as_of) }))].map((c) => {
            const pos = c as { title?: string; when?: string };
            const full = claims.find((x) => x.public_id === c.public_id);
            return html`<article class="fact-card">
              <h3>${pos.title ? pos.when : label(kindLabel, full?.kind)}</h3>
              <p>${pos.title ?? full?.claim_text ?? ""}</p>
              ${full?.known_limitations ? html`<details class="fact-src"><summary>Limitations</summary><p>${full.known_limitations}</p></details>` : ""}
              <span class="fact-src"><a href="/claims/${c.public_id}">${c.public_id}</a>${(ev.get(c.public_id) ?? []).filter((e) => e.evidence_role === "supports").slice(0, 1).map((e) => html`, ${e.title}`)}${basisTag(c.verification_basis)}</span>
            </article>`;
          })}</div></section>

        ${relationships.length ? html`<section class="vsec"><div class="vsec-head"><h2>Documented relationships</h2></div>
          ${relationshipsList(relationships, "", basis)}</section>` : ""}
        <p class="small sans vsec"><a href="/corrections?page=/people/${person.slug}">Report an error on this page</a></p>
      </div>`,
    }));
  }));

  // ---------------------------------------------------------------- Map
  r.get("/map", wrap(async (req, res) => {
    const graph = await loadGraph();
    const instFilter = str(req.query.institution, 80);
    const typeFilter = str(req.query.type, 60);
    const showHistorical = req.query.historical !== "0";
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    let edges = graph.edges;
    if (instFilter) edges = edges.filter((e) => e.source === `i:${instFilter}` || e.target === `i:${instFilter}`);
    if (typeFilter) edges = edges.filter((e) => e.type === typeFilter);
    if (!showHistorical) edges = edges.filter((e) => !e.historical);
    const presentTypes = [...new Set(graph.edges.map((e) => e.type))];
    const institutionsInGraph = graph.nodes.filter((n) => n.kind !== "person");

    send(res, 200, page({
      title: "Relationship Map", path: "/map", section: "map", editorial: req.editor,
      description: "Interactive map of verified relationships between Indian institutions, government bodies and officeholders, each linked to its evidence.",
      scripts: graph.edges.length ? ["/static/js/map.js"] : [],
      body: html`<div class="wrap">
        <h1>Relationship map</h1>
        <p class="lede">Every line on this map is a documented relationship with a source. Position on the map is a layout convenience and carries no meaning about influence, loyalty or integrity.</p>
        ${graph.edges.length === 0
          ? emptyState("No verified relationships yet",
              html`The map draws only relationships checked against an official or reliable record. None are published yet. When they are, they will appear here with a list view alongside. <a href="/methodology#relationships">See which relationships we record</a>.`)
          : html`<div class="map-shell">
            <form class="map-controls" method="get" action="/map" data-map-controls>
              <label>Find a person or institution<input type="search" name="find" data-map-search autocomplete="off"></label>
              <label>Institution<select name="institution"><option value="">All</option>
                ${institutionsInGraph.map((n) => html`<option value="${n.id.slice(2)}"${instFilter === n.id.slice(2) ? html` selected` : ""}>${n.label}</option>`)}</select></label>
              <label>Relationship type<select name="type"><option value="">All types</option>
                ${presentTypes.map((t) => html`<option value="${t}"${typeFilter === t ? html` selected` : ""}>${t === "held_position" ? "Held position at" : label(relationshipLabel, t)}</option>`)}</select></label>
              <fieldset><legend>Show</legend>
                <label class="check"><input type="checkbox" name="historical" value="1"${showHistorical ? html` checked` : ""} data-map-historical> Relationships that have ended</label>
                <label class="check"><input type="checkbox" checked data-map-kind="person"> People</label>
                <label class="check"><input type="checkbox" checked data-map-kind="institution"> Institutions and bodies</label>
              </fieldset>
              <noscript><button class="button plain" type="submit">Apply filters</button></noscript>
              <div><h2 class="legend-title">Legend</h2>
                <ul class="legend">${presentTypes.map((t) => html`<li>${legendSvg(t === "held_position" ? "double" : ({ appointed_by: "solid", nominated_by: "dash", selected_through: "dashdot", previously_held_position_at: "dot", served_as_member_of: "dot", formally_reports_to: "longdash", has_statutory_responsibility_for: "longdash", has_jurisdiction_over: "longdash", participates_in_appointment_of: "dashdot", subsequently_appointed_to: "dot" } as Record<string, string>)[t] ?? "solid")}
                  ${t === "held_position" ? "Held position at" : label(relationshipLabel, t)}</li>`)}
                  <li><svg width="40" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#fff" stroke="currentColor" stroke-width="1.5"/></svg> Person</li>
                  <li><svg width="40" height="14" aria-hidden="true"><rect x="1" y="1" width="12" height="12" fill="#e9e6f4" stroke="#4a3e8e" stroke-width="1.5"/></svg> Independent institution</li>
                  <li><svg width="40" height="14" aria-hidden="true"><rect x="1" y="1" width="12" height="12" fill="#fff" stroke="currentColor" stroke-width="1.5"/></svg> Government or other body</li>
                </ul>
                <p class="small sans quiet">Faded lines have ended. Line thickness is uniform and carries no meaning. Relationships checked by AI rather than a person are labelled in the details and the list.</p></div>
            </form>
            <div>
              <div class="map-canvas" data-map role="region" aria-label="Relationship map. A list of the same relationships follows."></div>
              <div class="detail-panel" data-map-detail aria-live="polite" hidden></div>
            </div>
          </div>
          <script type="application/json" id="graph-data">${jsonForScript(graph)}</script>

          <details class="section map-list-details" data-map-list-details open><summary><h2 id="h-list">All relationships as a list</h2></summary>
            <p class="small sans quiet">${edges.length} of ${graph.edges.length} relationships shown.</p>
            <ul class="rel-list" data-map-list>${edges.map((e) => {
              const s = nodeById.get(e.source)!; const t = nodeById.get(e.target)!;
              return html`<li id="edge-${e.id}" data-edge="${e.id}">
                <p class="rel-line"><a href="${s.href}">${s.label}</a> <span class="rel-type">${e.label.toLowerCase()}</span> <a href="${t.href}">${t.label}</a></p>
                <p>${e.description}</p>
                <p class="small sans quiet">${e.period}${e.historical ? ". Ended" : ""}. ${e.meaning} <a href="/claims/${e.claimId}">Evidence ${e.claimId}</a>${basisTag(e.checkedBy)}</p>
              </li>`;
            })}</ul>
          </details>`}
      </div>`,
    }));
  }));

  // ---------------------------------------------------------------- Claim (independently addressable)
  r.get("/claims/:id", wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!CLAIM_ID.test(id)) return notFound(res, req.editor);
    const c = await Q.getClaim(id);
    if (!c) {
      const w = await Q.getWithdrawal(id);
      if (!w) return notFound(res, req.editor);
      return send(res, 410, page({
        title: `Claim ${id} — withdrawn`, path: req.path, noindex: true, editorial: req.editor,
        description: `Claim ${id} is no longer published.`,
        body: html`<div class="wrap"><p class="small sans"><a href="/corrections">Corrections</a></p>
          <h1>Claim ${id}</h1>
          <div class="notice withdrawn">
            ${w.withdrawal_type === "withdrawn"
              ? html`<p><strong>This claim was withdrawn on ${formatTimestamp(w.withdrawn_at)}.</strong> It should not be relied on.</p>
                ${w.public_correction_note ? html`<p>${w.public_correction_note}</p>` : ""}`
              : html`<p><strong>This claim has been taken down while it is checked again.</strong> It was previously published. It will return only if it passes verification.</p>`}
            ${w.replaced_by_claim_id ? html`<p>See the corrected claim: <a href="/claims/${w.replaced_by_claim_id}">${w.replaced_by_claim_id}</a>.</p>` : ""}
          </div>
          <p class="small sans quiet">The text of withdrawn claims is not republished.</p></div>`,
      }));
    }
    const evidence = await Q.evidenceFor([id]);
    const subjectHref = c.institution_slug ? `/institutions/${c.institution_slug}` : `/people/${c.person_slug}`;
    const subjectName = c.institution_name ?? c.person_name ?? "";
    send(res, 200, page({
      title: `Claim ${id} — ${subjectName}`, path: req.path, editorial: req.editor,
      description: `Evidence record for claim ${id} about ${subjectName}: sources, location in source and verification date.`,
      body: html`<div class="wrap">
        <p class="small sans"><a href="${subjectHref}">${subjectName}</a></p>
        <h1 class="ids">Claim ${id}</h1>
        <p><span class="stamp">${label(categoryLabel, c.claim_category)}</span> <span class="small sans quiet">${label(kindLabel, c.kind)}</span></p>
        <p class="claim-text">${c.claim_text}</p>
        ${c.verification_basis === "ai" ? html`<div class="notice"><p><strong>Checked by AI, not yet by a person.</strong> An AI system opened the sources below and confirmed that they support this statement. No person on the editorial team has reviewed it yet. <a href="/methodology#checking">How checking works</a></p></div>` : ""}
        <dl class="meta-grid">
          ${c.temporal_scope ? html`<dt>Applies to</dt><dd>${c.temporal_scope}</dd>` : ""}
          <dt>Checked by</dt><dd>${c.verification_basis === "ai" ? "An AI system (not yet reviewed by a person)" : "A person on the editorial team"}</dd>
          <dt>Last checked</dt><dd>${formatTimestamp(c.last_verified_at)}</dd>
          <dt>Published</dt><dd>${formatTimestamp(c.published_at)}</dd>
          ${c.corrects_claim_id ? html`<dt>Corrects</dt><dd><a href="/claims/${c.corrects_claim_id}">${c.corrects_claim_id}</a></dd>` : ""}
        </dl>
        ${c.known_limitations ? html`<section class="section"><h2>Known limitations</h2><p class="prose">${c.known_limitations}</p></section>` : ""}
        <section class="section" aria-labelledby="h-ev"><h2 id="h-ev">Evidence</h2>
          <ul class="evidence">${evidence.map(sourceEntry)}</ul></section>
        <p class="sans small"><a href="/corrections?claim=${id}">Report a problem with this claim</a></p>
      </div>`,
    }));
  }));

  // ---------------------------------------------------------------- Methodology
  r.get("/methodology", (req, res) => {
    send(res, 200, page({
      title: "Methodology", path: "/methodology", section: "methodology", editorial: req.editor,
      description: "How Institutional Proximity verifies claims: source standards, the publication workflow, relationship definitions and known limitations.",
      body: methodologyBody(),
    }));
  });

  // ---------------------------------------------------------------- Corrections
  const correctionsPage = async (req: Request, res: Response, state: { ok?: string; error?: string; values?: Record<string, string> } = {}) => {
    const withdrawals = await Q.listWithdrawals();
    const v = state.values ?? { claim: str(req.query.claim, 9), page: str(req.query.page, 300), message: "", name: "", contact: "" };
    send(res, state.error ? 400 : 200, page({
      title: "Corrections", path: "/corrections", section: "corrections", editorial: req.editor,
      description: "Our corrections policy, how to report an inaccurate claim, and the public log of withdrawn claims.",
      body: html`<div class="wrap">
        <h1>Corrections</h1>
        <div class="frame">
          <div class="prose">
            <p class="lede">If something on this site is wrong, out of date or unfairly described, tell us. Every claim has an ID so it can be checked, corrected or withdrawn on its own.</p>
            <h2>What happens when you report a problem</h2>
            <ol>
              <li>Your report goes to a private editorial inbox. It is never published automatically.</li>
              <li>An editor re-checks the claim against its sources. If there is reasonable doubt, the claim is taken down while it is checked.</li>
              <li>If the claim is wrong, it is withdrawn and listed below with a note. If a corrected version is published, it links to the withdrawn one.</li>
              <li>Serious disputes, including any concern about defamation or privacy, are referred for editorial and legal review.</li>
            </ol>
          </div>
          <aside class="note">We keep an internal record of every change, including withdrawals. We do not republish the text of a withdrawn claim.</aside>
        </div>

        <section class="section" id="report" aria-labelledby="h-report"><h2 id="h-report">Report a problem</h2>
          ${state.ok ? html`<div class="notice" role="status"><p><strong>Report received.</strong> Your reference is <span class="ids">${state.ok}</span>. An editor will review it.</p></div>` : ""}
          ${state.error ? html`<div class="notice error" role="alert"><p>${state.error}</p></div>` : ""}
          <form class="form" method="post" action="/corrections">
            <div class="row">
              <label>Claim ID <span class="hint">Optional, for example C-000123</span><input type="text" name="claim" value="${v.claim}" pattern="C-[0-9]{6}" maxlength="8"></label>
              <label>Page <span class="hint">Optional</span><input type="text" name="page" value="${v.page}" maxlength="300"></label>
            </div>
            <label>What is wrong? <span class="hint">Point to a source if you can.</span><textarea name="message" required minlength="10" maxlength="5000">${v.message}</textarea></label>
            <div class="row">
              <label>Your name <span class="hint">Optional</span><input type="text" name="name" value="${v.name}" maxlength="120" autocomplete="name"></label>
              <label>How can we reach you? <span class="hint">Optional. Used only to follow up on this report.</span><input type="text" name="contact" value="${v.contact}" maxlength="200"></label>
            </div>
            <label class="hp" aria-hidden="true">Leave empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
            <div><button class="button" type="submit">Send report</button></div>
          </form>
        </section>

        <section class="section" aria-labelledby="h-log"><h2 id="h-log">Withdrawn and re-checked claims</h2>
          ${withdrawals.length === 0 ? html`<p class="quiet">No published claim has been withdrawn or taken down for re-checking.</p>`
            : html`<ul class="rel-list">${withdrawals.map((w) => html`<li>
              <p><span class="ids withdrawn-item">${w.claim_id}</span> <span class="stamp withdrawn">${w.withdrawal_type === "withdrawn" ? "Withdrawn" : "Taken down for re-checking"}</span></p>
              <p class="small sans">${label(kindLabel, w.kind)}${w.institution_name ? html` about ${w.institution_name}` : ""}${w.person_name ? html` about ${w.person_name}` : ""}. ${formatTimestamp(w.withdrawn_at)}.</p>
              ${w.public_correction_note ? html`<p>${w.public_correction_note}</p>` : ""}
              ${w.replaced_by_claim_id ? html`<p class="small sans">Corrected by <a href="/claims/${w.replaced_by_claim_id}">${w.replaced_by_claim_id}</a></p>` : ""}
            </li>`)}</ul>`}
        </section>
      </div>`,
    }));
  };

  r.get("/corrections", wrap(async (req, res) => correctionsPage(req, res)));
  r.post("/corrections", rateLimit({ windowMs: 60 * 60 * 1000, max: 8, key: "corrections" }), wrap(async (req, res) => {
    const values = {
      claim: str(req.body.claim, 8), page: str(req.body.page, 300), message: str(req.body.message, 5000),
      name: str(req.body.name, 120), contact: str(req.body.contact, 200),
    };
    if (str(req.body.website, 200)) return correctionsPage(req, res, { ok: "received" }); // honeypot: quietly drop
    if (values.claim && !CLAIM_ID.test(values.claim)) return correctionsPage(req, res, { error: "Claim IDs look like C-000123. Check the ID or leave it empty.", values });
    if (values.message.length < 10) return correctionsPage(req, res, { error: "Describe the problem in at least 10 characters so an editor can act on it.", values });
    const ref = await Q.submitCorrection({
      claimId: values.claim || null, pagePath: values.page || null, message: values.message,
      name: values.name || null, contact: values.contact || null,
    });
    return correctionsPage(req, res, { ok: ref, values: { claim: "", page: "", message: "", name: "", contact: "" } });
  }));

  // ---------------------------------------------------------------- Public JSON API (published data only)
  const api = Router();
  api.use(rateLimit({ windowMs: 60 * 1000, max: 120, key: "api" }));
  api.get("/status", wrap(async (_req, res) => { res.json(await Q.siteStatus()); }));
  api.get("/institutions", wrap(async (_req, res) => { res.json(await Q.listInstitutions()); }));
  api.get("/institutions/:slug", wrap(async (req, res) => {
    const slug = String(req.params.slug);
    if (!SLUG.test(slug)) { res.status(404).json({ error: "not_found" }); return; }
    const d = await loadInstitution(slug);
    if (!d) { res.status(404).json({ error: "not_found" }); return; }
    const { ev, ...rest } = d;
    void ev;
    res.json(rest);
  }));
  api.get("/graph", wrap(async (_req, res) => { res.json(await loadGraph()); }));
  api.get("/claims/:id", wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!CLAIM_ID.test(id)) { res.status(404).json({ error: "not_found" }); return; }
    const c = await Q.getClaim(id);
    if (!c) {
      const w = await Q.getWithdrawal(id);
      if (w) { res.status(410).json({ claim_id: id, status: w.withdrawal_type, note: w.public_correction_note, replaced_by: w.replaced_by_claim_id }); return; }
      res.status(404).json({ error: "not_found" }); return;
    }
    res.json({ claim: c, evidence: await Q.evidenceFor([id]) });
  }));
  api.get("/relationship-types", (_req, res) => {
    res.json(RELATIONSHIP_TYPES.map((t) => ({ type: t, label: relationshipLabel[t], meaning: relationshipMeaning[t] })));
  });
  r.use("/api/public", api);

  return r;
}

