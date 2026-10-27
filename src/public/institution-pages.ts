import { html, safeHref, SafeHtml } from "../lib/html.js";
import { formatDated, formatRange, formatTimestamp } from "../lib/dates.js";
import {
  appointmentTypeLabel, eventRelationLabel, label, legalCategoryLabel, legalEventLabel,
  relationshipLabel, safeguardLabel,
} from "../lib/labels.js";
import * as Q from "./queries.js";
import { basisTag, emptyState, fact, groupEvidence } from "./components.js";
import type { VizData } from "./visual-data.js";
import { appointmentWeb, detailPanel, pipelineFlow, safeguardTiles, statStrip, timeline, vizData as vizDataScript } from "./visuals.js";

const FACET_ORDER = ["identity", "legal_basis", "mandate", "composition", "funding", "accountability", "other"];
const FACET_HEADINGS: Record<string, string> = {
  legal_basis: "Legal basis", mandate: "Mandate", composition: "Composition", funding: "Funding arrangements",
  accountability: "Reporting and accountability", other: "Other documented facts",
};

export async function loadInstitution(slug: string) {
  const inst = await Q.getInstitution(slug);
  if (!inst) return null;
  const [claims, processes, safeguards, events, positions, relationships, coverage] = await Promise.all([
    Q.claimsForInstitution(slug), Q.processesFor(slug), Q.safeguardsFor(slug), Q.legalEventsFor(slug),
    Q.positionsForInstitution(inst.id), Q.relationshipsFor("institution", inst.id), Q.coverageFor(slug),
  ]);
  const stages = await Q.stagesFor(processes.map((p) => p.id));
  const ids = new Set<string>([
    ...claims.map((c) => c.public_id), ...processes.map((p) => p.claim_id), ...stages.map((s) => s.claim_id),
    ...safeguards.map((s) => s.claim_id), ...events.map((e) => e.claim_id), ...positions.map((p) => p.claim_id),
    ...relationships.map((r) => r.claim_id),
  ]);
  const [evidence, basis] = await Promise.all([Q.evidenceFor([...ids]), Q.basisFor([...ids])]);
  return { inst, claims, processes, stages, safeguards, events, positions, relationships, coverage, evidence, ev: groupEvidence(evidence), basis };
}
export type InstitutionData = NonNullable<Awaited<ReturnType<typeof loadInstitution>>>;

export function pipelineSection(d: InstitutionData, opts: { full: boolean }): SafeHtml {
  if (d.processes.length === 0) {
    return emptyState("No verified appointment process yet",
      "The legal process for appointing this institution's officeholders has not yet been verified against its source. It will appear here once it has been checked.");
  }
  return html`${d.processes.map((p) => {
    const stages = d.stages.filter((s) => s.process_id === p.id);
    const historical = p.effective_until && p.effective_until_precision !== "unknown";
    return html`<div class="frame">
      <div class="full"><h3>${p.office_title}${historical ? html` <span class="stamp neutral">Historical</span>` : ""}</h3>
        <p class="small sans quiet">In effect: ${formatRange(p.effective_from, p.effective_from_precision, p.effective_until, p.effective_until_precision)}.
          Legal basis: ${p.legal_basis}.</p></div>
      ${fact(html`<p>${p.process_description}</p>`, p.claim_id, d.ev.get(p.claim_id) ?? [], null, { basis: d.basis.get(p.claim_id) })}
      <div class="full">
        ${stages.length === 0
          ? html`<p class="small sans quiet">The individual stages of this process have not yet been verified.</p>`
          : html`<ol class="pipeline" aria-label="Stages of the appointment process">
            ${stages.map((s) => html`<li id="stage-${s.id}">
              <details${opts.full ? html` open` : ""}>
                <summary>${s.stage_title}<span class="actor">${s.actor_label}</span></summary>
                <div class="stage-body frame">
                  ${s.actor_institution_slug ? html`<p class="full small sans"><a href="/institutions/${s.actor_institution_slug}">About ${s.actor_institution_name ?? s.actor_label}</a></p>` : ""}
                  ${fact(html`<p>${s.role_description}</p>${s.provision_label ? html`<p class="small sans quiet">Provision: ${s.provision_label}</p>` : ""}`,
                    s.claim_id, d.ev.get(s.claim_id) ?? [], null, { basis: d.basis.get(s.claim_id) })}
                </div>
              </details>
            </li>`)}
          </ol>`}
      </div>
    </div>`;
  })}
  <p class="law-vs-practice">This sequence describes what the law or official framework provides. It does not describe how any particular appointment was made; where a specific appointment is documented, it is shown under officeholders with its own source.</p>`;
}

export function safeguardsSection(d: InstitutionData, active?: string): SafeHtml {
  if (d.safeguards.length === 0) {
    return emptyState("No verified safeguards yet",
      "Provisions on tenure, removal, conditions of service and similar protections will appear here once each has been checked against the legal text.");
  }
  const dims = [...new Set(d.safeguards.map((s) => s.dimension))];
  const shown = active && dims.includes(active) ? d.safeguards.filter((s) => s.dimension === active) : d.safeguards;
  return html`<nav class="dims" aria-label="Filter safeguards" data-safeguard-filter>
      <a href="?#safeguards" aria-current="${!active ? "true" : "false"}" data-dim="">All</a>
      ${dims.map((dm) => html`<a href="?safeguard=${dm}#safeguards" aria-current="${active === dm ? "true" : "false"}" data-dim="${dm}">${label(safeguardLabel, dm)}</a>`)}
    </nav>
    ${shown.map((s) => html`<article class="safeguard frame" data-dimension="${s.dimension}">
      <div class="full"><h3>${label(safeguardLabel, s.dimension)}: ${s.provision_label}</h3></div>
      ${fact(html`<div class="estab">
          <div><h4>What the provision establishes</h4><p>${s.establishes}</p></div>
          <div><h4>What it does not establish</h4><p>${s.does_not_establish}</p></div>
        </div>
        ${s.limitations ? html`<p class="small sans quiet">Limitations: ${s.limitations}</p>` : ""}`,
        s.claim_id, d.ev.get(s.claim_id) ?? [], s.last_verified_at, { basis: d.basis.get(s.claim_id) })}
    </article>`)}
    <p class="law-vs-practice">Formal safeguards describe the legal design. They are not, on their own, evidence of how independently an institution operates in practice.</p>`;
}

export function officeholdersSection(d: InstitutionData): SafeHtml {
  if (d.positions.length === 0) {
    return emptyState("No verified officeholders yet",
      "Officeholders are listed only when their name, position and dates have been checked against an official record.");
  }
  return html`<ol class="timeline">${d.positions.map((p) => html`<li class="${p.start_date ? "" : "undated"}">
    <span class="when">${formatRange(p.start_date, p.start_precision, p.end_date, p.end_precision, p.ongoing_as_of)}</span>
    <h3><a href="/people/${p.person_slug}">${p.person_name}</a>, ${p.title}</h3>
    <p class="small sans">${label(appointmentTypeLabel, p.appointment_type)}${p.appointing_authority_slug
      ? html`. Appointing authority: <a href="/institutions/${p.appointing_authority_slug}">${p.appointing_authority_name}</a>` : ""}.
      <a href="/claims/${p.claim_id}">Evidence ${p.claim_id}</a>${basisTag(d.basis.get(p.claim_id))}</p>
  </li>`)}</ol>`;
}

export function relationshipsList(rels: Q.Relationship[], emptyMsg: string, basis: Map<string, "human" | "ai" | null> = new Map()): SafeHtml {
  if (rels.length === 0) return emptyState("No verified relationships yet", emptyMsg);
  return html`<ul class="rel-list">${rels.map((r) => html`<li>
    <p class="rel-line"><a href="/${r.source_type === "person" ? "people" : "institutions"}/${r.source_slug}">${r.source_name}</a>
      <span class="rel-type">${label(relationshipLabel, r.relationship_type).toLowerCase()}</span>
      <a href="/${r.target_type === "person" ? "people" : "institutions"}/${r.target_slug}">${r.target_name}</a></p>
    <p>${r.description}</p>
    <p class="small sans quiet">${formatRange(r.valid_from, r.valid_from_precision, r.valid_until, r.valid_until_precision)}.
      <a href="/claims/${r.claim_id}">Evidence ${r.claim_id}</a>${basisTag(basis.get(r.claim_id))}</p>
  </li>`)}</ul>`;
}

export function legalTimeline(events: Q.LegalEvent[], basis: Map<string, "human" | "ai" | null> = new Map()): SafeHtml {
  if (events.length === 0) {
    return emptyState("No verified legal history yet",
      "Constitutional provisions, statutes, amendments, rules and judgments will appear here in date order once checked.");
  }
  const byId = new Map(events.map((e) => [e.id, e]));
  return html`<ol class="timeline">${events.map((e) => {
    const rel = e.related_event_id ? byId.get(e.related_event_id) : undefined;
    return html`<li id="event-${e.id}" class="${e.event_date ? "" : "undated"}">
      <span class="when">${formatDated(e.event_date, e.event_precision)}. ${label(legalEventLabel, e.event_type)}</span>
      <h3>${e.title}</h3>
      ${e.procedural_status ? html`<p class="small sans">Status: ${e.procedural_status}</p>` : ""}
      ${rel && e.relation_to_related ? html`<p class="small sans">${label(eventRelationLabel, e.relation_to_related)}: <a href="#event-${rel.id}">${rel.title}</a></p>` : ""}
      <p class="small sans"><a href="/claims/${e.claim_id}">Evidence ${e.claim_id}</a>${basisTag(basis.get(e.claim_id))}</p>
    </li>`;
  })}</ol>`;
}

const aiCount = (d: InstitutionData) => [...d.basis.values()].filter((b) => b === "ai").length;

/** Visual-first institution profile. Full text stays one click away (cards, panels, details). */
export function institutionProfile(d: InstitutionData, viz: VizData): SafeHtml {
  const { inst } = d;
  const facets = FACET_ORDER.flatMap((k) => d.claims.filter((c) => c.kind === k));
  const allSources = new Map<string, Q.Evidence>();
  for (const e of d.evidence) if (!allSources.has(e.source_id)) allSources.set(e.source_id, e);
  const vStages = viz.stages.filter((s) => s.institution === inst.slug);
  const vSafeguards = viz.safeguards.filter((s) => s.institution === inst.slug);
  const hasLinks = viz.links.some((l) => l.source === inst.slug || l.target === inst.slug);
  const hasTimeline = viz.events.some((e) => e.institution === inst.slug && e.date) || viz.tenures.some((t) => t.institution === inst.slug && t.start);

  return html`${vizDataScript(viz)}<div class="wrap-wide">
    <p class="small sans"><a href="/institutions">Institutions</a></p>
    <header class="hero-v">
      <div>
        <h1>${inst.canonical_name}</h1>
        <p>${label(legalCategoryLabel, inst.legal_category)}${inst.official_website ? html`. <a href="${safeHref(inst.official_website)}" rel="noopener noreferrer">Official website</a>` : ""}</p>
      </div>
      ${statStrip([
        { value: d.coverage?.published ?? 0, label: "published claims" },
        { value: vSafeguards.length, label: "safeguards" },
        { value: d.positions.length, label: "tenures" },
      ])}
    </header>
    ${aiCount(d) > 0 ? html`<p class="viz-caption">Items marked <span class="stamp ai">Checked by AI</span> were checked against their sources by an AI system and not yet by a person. Last checked ${formatTimestamp(inst.last_verified_at)}.</p>` : ""}

    ${facets.length ? html`<section class="vsec" aria-labelledby="h-glance">
      <div class="vsec-head"><h2 id="h-glance">At a glance</h2></div>
      <div class="fact-cards">${facets.map((c) => html`<article class="fact-card">
        <h3>${c.kind === "identity" ? "What it is" : FACET_HEADINGS[c.kind] ?? c.kind}</h3>
        <p>${c.claim_text}</p>
        ${c.known_limitations ? html`<details class="fact-src"><summary>Limitations</summary><p>${c.known_limitations}</p></details>` : ""}
        <span class="fact-src"><a href="/claims/${c.public_id}">${c.public_id}</a>${(d.ev.get(c.public_id) ?? []).filter((e) => e.evidence_role === "supports").slice(0, 1).map((e) => html`, ${e.title}${e.relevant_section ? html`, ${e.relevant_section}` : ""}`)}${basisTag(c.verification_basis)}</span>
      </article>`)}</div>
    </section>` : ""}

    <section class="vsec" id="appointment" aria-labelledby="h-appt">
      <div class="vsec-head"><h2 id="h-appt">How appointments are made</h2>
        <p>Select a stage to read what the law says. This shows the legal design, not how any particular appointment was made.</p></div>
      ${d.processes.length === 0 ? emptyState("No verified appointment process yet", "It will appear here once checked against its source.")
        : d.processes.map((p) => {
          const st = vStages.filter((s) => s.process === p.office_title);
          const historical = p.effective_until && p.effective_until_precision !== "unknown";
          return html`<div class="process-head"><h3>${p.office_title}</h3>
              <span>${historical ? "Historical. " : ""}${p.effective_from ? `In effect from ${formatDated(p.effective_from, p.effective_from_precision)}${historical ? ` to ${formatDated(p.effective_until, p.effective_until_precision)}` : ""}.` : "Start date not established."} ${p.legal_basis}. <a href="/claims/${p.claim_id}">${p.claim_id}</a>${basisTag(d.basis.get(p.claim_id))}</span></div>
            ${st.length ? pipelineFlow(st, p.office_title) : html`<p class="quiet small sans">${p.process_description}</p>`}`;
        })}
      ${detailPanel("appt-panel")}
    </section>

    ${vSafeguards.length ? html`<section class="vsec" id="safeguards" aria-labelledby="h-safe">
      <div class="vsec-head"><h2 id="h-safe">Safeguards</h2><p>Open a tile to see what each provision does and does not establish.</p></div>
      ${safeguardTiles(vSafeguards)}
    </section>` : ""}

    ${hasLinks ? html`<section class="vsec" id="relationships" aria-labelledby="h-rel">
      <div class="vsec-head"><h2 id="h-rel">Who is involved</h2><a href="/map?institution=${inst.slug}">On the full map</a></div>
      ${appointmentWeb(viz, inst.slug)}
    </section>` : ""}

    ${hasTimeline ? html`<section class="vsec" id="history" aria-labelledby="h-hist">
      <div class="vsec-head"><h2 id="h-hist">Timeline</h2><p>Laws, judgments and documented tenures. Select a mark for details.</p></div>
      ${timeline(viz, { id: "inst-tl", institutions: [inst.slug] })}
    </section>` : ""}

    <section class="vsec" id="sources" aria-labelledby="h-src">
      <div class="vsec-head"><h2 id="h-src">Sources</h2></div>
      <details class="viz-table"><summary>${allSources.size} ${allSources.size === 1 ? "source" : "sources"} used on this page</summary>
        <ul class="evidence">${[...allSources.values()].map((e) => html`<li><a href="${safeHref(e.canonical_url)}" rel="noopener noreferrer">${e.title}</a>
          <span class="small sans quiet">${e.publisher}. ${e.accessed_at ? html`Accessed ${formatDated(e.accessed_at, "day")}.` : "Not yet opened by a reviewer; context only."}</span></li>`)}</ul>
      </details>
      <p class="small sans"><a href="/corrections?page=/institutions/${inst.slug}">Report an error on this page</a></p>
    </section>
  </div>`;
}

export function appointmentPage(d: InstitutionData): SafeHtml {
  return html`<div class="wrap">
    <p class="small sans"><a href="/institutions/${d.inst.slug}">${d.inst.canonical_name}</a></p>
    <h1>How appointments are made</h1>
    <p class="lede">Each stage below is drawn from the legal text that establishes it. Select a stage to read what the provision says and see its source.</p>
    ${pipelineSection(d, { full: true })}
    <section class="section" aria-labelledby="h-changes"><h2 id="h-changes">Changes over time</h2>
      ${legalTimeline(d.events, d.basis)}
    </section>
  </div>`;
}

