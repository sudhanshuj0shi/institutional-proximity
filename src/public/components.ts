import { html, safeHref, SafeHtml } from "../lib/html.js";
import { formatDated, formatTimestamp } from "../lib/dates.js";
import { categoryLabel, sourceTypeLabel, tierLabel, label } from "../lib/labels.js";
import type { Claim, Evidence } from "./queries.js";

export function groupEvidence(ev: Evidence[]): Map<string, Evidence[]> {
  const m = new Map<string, Evidence[]>();
  for (const e of ev) {
    const list = m.get(e.claim_id) ?? [];
    list.push(e);
    m.set(e.claim_id, list);
  }
  return m;
}

export type Basis = "human" | "ai" | null | undefined;

/** Visible label for claims checked by an automated reviewer. Never shown for human checks. */
export function basisTag(basis: Basis): SafeHtml {
  return basis === "ai" ? html` <span class="stamp ai" title="Checked against its source by an AI system; not yet reviewed by a person">Checked by AI</span>` : html``;
}

/** The marginal note: claim ID, short citations, verification date and who checked it. */
export function marginNote(claimId: string, evidence: Evidence[], lastVerified?: Date | string | null, basis?: Basis): SafeHtml {
  const supports = evidence.filter((e) => e.evidence_role === "supports");
  return html`<aside class="note" aria-label="Evidence for this statement">
    <p><a class="cid" href="/claims/${claimId}">${claimId}</a></p>
    ${supports.slice(0, 3).map((e) => html`<p>${e.title}${e.relevant_section ? html`, ${e.relevant_section}` : ""}</p>`)}
    ${supports.length > 3 ? html`<p>and ${supports.length - 3} more</p>` : ""}
    ${basis === "ai"
      ? html`<p class="ai-line">Checked by AI${lastVerified ? html` on ${formatTimestamp(lastVerified)}` : ""}. Not yet reviewed by a person.</p>`
      : lastVerified ? html`<p>Verified by a person ${formatTimestamp(lastVerified)}</p>` : ""}
  </aside>`;
}

/** A factual paragraph with its marginal note. Must sit inside a .frame grid. */
export function fact(body: SafeHtml, claimId: string, evidence: Evidence[], lastVerified?: Date | string | null, opts: { category?: string; basis?: Basis } = {}) {
  return html`<div class="fact">
    <div class="fact-body">
      ${opts.category === "official_finding" ? html`<p><span class="stamp">${label(categoryLabel, opts.category)}</span></p>` : ""}
      ${body}
    </div>
    ${marginNote(claimId, evidence, lastVerified, opts.basis)}
  </div>`;
}

export function claimFact(c: Claim, ev: Map<string, Evidence[]>) {
  return fact(html`<p>${c.claim_text}</p>${c.known_limitations ? html`<p class="quiet small sans">Limitation: ${c.known_limitations}</p>` : ""}`,
    c.public_id, ev.get(c.public_id) ?? [], c.last_verified_at, { category: c.claim_category, basis: c.verification_basis });
}

export function emptyState(title: string, body: SafeHtml | string): SafeHtml {
  return html`<div class="empty" role="status"><h3>${title}</h3><p>${body}</p></div>`;
}

export function sourceEntry(e: Evidence): SafeHtml {
  return html`<li>
    <p><strong><a href="${safeHref(e.canonical_url)}" rel="noopener noreferrer">${e.title}</a></strong></p>
    <dl class="meta-grid">
      <dt>Role</dt><dd>${e.evidence_role === "supports" ? "Supports the claim" : e.evidence_role === "contradicts" ? "Contradicts or complicates the claim" : "Context"}</dd>
      <dt>Publisher</dt><dd>${e.publisher}</dd>
      <dt>Source type</dt><dd>${label(sourceTypeLabel, e.source_type)} (${tierLabel[e.tier] ?? ""})</dd>
      <dt>Location in source</dt><dd>${e.relevant_section ?? "Not recorded"}</dd>
      ${e.document_identifier ? html`<dt>Document identifier</dt><dd>${e.document_identifier}</dd>` : ""}
      ${e.document_version ? html`<dt>Version</dt><dd>${e.document_version}</dd>` : ""}
      <dt>Published</dt><dd>${formatDated(e.publication_date, e.publication_precision)}</dd>
      <dt>Accessed</dt><dd>${e.accessed_at ? formatDated(e.accessed_at, "day") : "Not recorded"}</dd>
      ${e.confirmed_on ? html`<dt>Passage confirmed</dt><dd>${formatDated(e.confirmed_on, "day")}, ${e.check_basis === "ai" ? "by an AI system (not yet by a person)" : "by a person on the editorial team"}</dd>` : ""}
      ${e.archived_url ? html`<dt>Archived copy</dt><dd><a href="${safeHref(e.archived_url)}" rel="noopener noreferrer">View archived copy</a></dd>` : ""}
      ${e.availability === "unavailable" ? html`<dt>Availability</dt><dd>This source was unavailable at last check. The claim is being re-verified.</dd>` : ""}
    </dl>
    ${e.supporting_excerpt ? html`<blockquote>${e.supporting_excerpt}</blockquote>` : ""}
    ${e.passage_description ? html`<p class="small sans">${e.passage_description}</p>` : ""}
  </li>`;
}

export function statusLedger(s: { published_claims: string; awaiting_review: string; in_research: string; published_ai_checked?: string }) {
  const pub = Number(s.published_claims);
  const waiting = Number(s.awaiting_review);
  const researching = Number(s.in_research);
  return html`<p class="ledger">
    ${pub === 0 ? html`No claims are published yet.` : html`<strong>${pub}</strong> ${pub === 1 ? "claim is" : "claims are"} published.`}
    ${pub > 0 && Number(s.published_ai_checked ?? 0) > 0 ? html` <strong>${s.published_ai_checked}</strong> of these ${Number(s.published_ai_checked) === 1 ? "was" : "were"} checked against the source by an AI system and ${Number(s.published_ai_checked) === 1 ? "has" : "have"} not yet been reviewed by a person.` : ""}
    ${waiting > 0 ? html` <strong>${waiting}</strong> ${waiting === 1 ? "claim is" : "claims are"} waiting to be checked against the source.` : ""}
    ${researching > 0 ? html` <strong>${researching}</strong> more ${researching === 1 ? "is" : "are"} still being researched.` : ""}
  </p>`;
}
