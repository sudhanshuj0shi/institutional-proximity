import { html } from "../lib/html.js";
import { categoryLabel, categoryMeaning, relationshipLabel, relationshipMeaning, RELATIONSHIP_TYPES, statusLabel } from "../lib/labels.js";

const STATUS_MEANING: Record<string, string> = {
  draft: "Being written. Not public.",
  researching: "Sources are being located and read. Not public.",
  pending_review: "Submitted with its sources. Waiting to be checked. Not public.",
  verified: "A reviewer who did not write the claim, either a person or an AI reviewer, has opened each source and confirmed the passage. Not yet public.",
  published: "Approved for publication. Shown on the site, labelled with who checked it.",
  needs_reverification: "Taken down because a source changed, became unavailable, or the claim needs checking again.",
  disputed: "Taken down because a credible challenge has been raised.",
  retracted: "Withdrawn permanently. Listed on the corrections page with a note; the text is not republished.",
};

export function methodologyBody() {
  return html`<div class="wrap">
    <h1>Methodology</h1>
    <div class="frame">
      <div class="prose">
        <p class="lede">This site asks one question: how independent are India's institutions in their formal structures, appointment processes, safeguards and documented functioning? It answers only with what the record establishes.</p>
        <p>Four rules govern everything here. Evidence comes before interpretation. Transparency comes before scoring. Verification comes before publication. Analysis of institutions comes before anything said about individuals.</p>
      </div>
      <aside class="note">This methodology is part of the product. If any page appears to break it, <a href="/corrections">report it</a>.</aside>
    </div>

    <section class="section prose" id="what-we-publish" aria-labelledby="h-pub">
      <h2 id="h-pub">What we publish, and what we do not</h2>
      <dl class="def-list">${["verified_fact", "official_finding", "reported_allegation", "analytical_interpretation", "unknown"].map((k) =>
        html`<dt>${categoryLabel[k]}</dt><dd>${categoryMeaning[k]}</dd>`)}</dl>
      <p>This version publishes only verified facts and official findings. The database will refuse to publish anything else. Where a court has made a finding, we describe its scope and procedural status; an allegation recorded in a judgment is not treated as established.</p>
      <p>We do not publish integrity scores, bias ratings, or a composite measure of independence. We do not infer anyone's political beliefs or party affiliation, including from government employment.</p>
    </section>

    <section class="section" id="sources" aria-labelledby="h-src">
      <h2 id="h-src">Source standards</h2>
      <div class="table-scroll"><table class="plain">
        <thead><tr><th scope="col">Tier</th><th scope="col">Includes</th><th scope="col">Can it establish a claim?</th></tr></thead>
        <tbody>
          <tr><td>1. Primary</td><td>The Constitution, Acts and gazette notifications, Supreme Court and High Court judgments, official institutional websites and reports, appointment notifications, parliamentary records and committee reports, official government publications.</td><td>Yes. Required for sensitive claims.</td></tr>
          <tr><td>2. Reputable secondary</td><td>Established news organisations with editorial standards, peer-reviewed research, reputable academic and legal research, civil society research with a transparent method.</td><td>Yes, for non-sensitive claims, after evaluation.</td></tr>
          <tr><td>3. Discovery</td><td>Search engines, social media, forums, unverified blogs, AI-generated summaries.</td><td>Never. Used only to find original documents.</td></tr>
        </tbody>
      </table></div>
      <p class="prose">A source's tier is a starting point. Editors still judge whether a source is authentic, relevant, current, and actually says what the claim says. A web address alone is not proof. Every source records its publisher, publication date where known, the date it was accessed, and the page, article, section or paragraph relied on. Short excerpts are kept only where they are accurate and lawful to reproduce.</p>
    </section>

    <section class="section" id="workflow" aria-labelledby="h-wf">
      <h2 id="h-wf">How a claim is verified</h2>
      <div class="prose">
        <p>Every statement on the site is a claim with its own public ID. A claim moves through these states:</p>
        <div class="table-scroll"><table class="plain"><tbody>
          ${Object.keys(STATUS_MEANING).map((k) => html`<tr><th scope="row">${statusLabel[k]}</th><td>${STATUS_MEANING[k]}</td></tr>`)}
        </tbody></table></div>
        <p>These rules are enforced by the database itself, not just the website:</p>
        <ul>
          <li>A claim cannot be verified by the account that wrote it.</li>
          <li>Each supporting source must be opened by a reviewer, who confirms the passage and records when they accessed it. The reviewer is either a person or an AI reviewer, and the site says which (see <a href="#checking">who checked a claim</a>).</li>
          <li>Sensitive claims can only be checked and published by a person.</li>
          <li>A claim needs at least one primary or reputable secondary source; a sensitive claim needs a primary source.</li>
          <li>If sources conflict, both are kept and the conflict is described under known limitations before the claim can be verified.</li>
          <li>Once verified, a claim and its evidence are locked. To change them, the claim is taken down and checked again.</li>
          <li>The public site reads from a separate, read-only view of published records. Drafts and internal notes are not reachable from it.</li>
          <li>Every change is recorded in an internal audit log that cannot be edited.</li>
        </ul>
      </div>
    </section>

    <section class="section prose" id="checking" aria-labelledby="h-check">
      <h2 id="h-check">Who checked a claim</h2>
      <p>Every published claim carries one of two labels.</p>
      <dl class="def-list">
        <dt>Checked by a person</dt>
        <dd>A person on the editorial team, other than the claim's author, opened each supporting source and confirmed the passage.</dd>
        <dt>Checked by AI, not yet by a person</dt>
        <dd>An AI system opened each supporting source, located the cited passage and confirmed it supports the claim. No person has yet reviewed it. The same AI system that found these claims also checked them, so this is not an independent second check.</dd>
      </dl>
      <p>AI-checked claims are held to the same evidence rules as any other: a primary or reputable secondary source, a recorded access date, a page or section reference, and any conflicting evidence disclosed. Sources the AI system could not open stay unpublished. Claims marked sensitive cannot be AI-checked.</p>
      <p>Treat AI-checked claims with more caution. Automated tools can misread documents, and short excerpts captured by them may not be word-perfect. When a person reviews an AI-checked claim, its label changes. If you spot an error, <a href="/corrections">report it</a>.</p>
    </section>

    <section class="section" id="relationships" aria-labelledby="h-rel">
      <h2 id="h-rel">Relationships we record</h2>
      <div class="prose">
        <p>"Proximity" in this project's name describes structural closeness: who appoints whom, who reports to whom, who sits on which committee. It never implies guilt, improper conduct or political allegiance. We record only these relationship types, and only when a source establishes them:</p>
        <dl class="def-list">${RELATIONSHIP_TYPES.map((t) => html`<dt>${relationshipLabel[t]}</dt><dd>${relationshipMeaning[t]}</dd>`)}</dl>
        <p>We never draw a relationship from similar opinions, shared photographs, personal acquaintance, social media claims, assumed ideology, coincidental career overlap or unproven allegations.</p>
      </div>
    </section>

    <section class="section prose" id="dates" aria-labelledby="h-dates">
      <h2 id="h-dates">Dates and missing information</h2>
      <p>A date is shown only as precisely as its source gives it. If a source gives only a year, we show only the year. If a date cannot be established, we say so rather than estimate it. We never infer an appointment date from a publication date, and we never assume someone still holds an office because an older page says so; an officeholder is described as in office only as of a date a source confirms.</p>
      <p>Missing information is shown as missing. An empty section means nothing has yet been verified, not that something is wrong.</p>
    </section>

    <section class="section prose" id="scope" aria-labelledby="h-scope">
      <h2 id="h-scope">Scope</h2>
      <p>Research has started with three bodies: the Election Commission of India, the Comptroller and Auditor General of India and the Central Information Commission. They were chosen because their legal frameworks differ. Each one's legal basis is stated on its profile, with sources, once verified. Constitutional bodies, statutory bodies and executive agencies are never treated as interchangeable, and each profile follows its own legal framework rather than a common checklist.</p>
      <p>Formal safeguards describe how an institution is designed. They are not, by themselves, evidence of how it behaves in practice.</p>
    </section>

    <section class="section prose" id="privacy" aria-labelledby="h-priv">
      <h2 id="h-priv">Privacy</h2>
      <p>We include only information relevant to a person's public role: positions held, dates, appointing authorities, and documented professional relationships. We do not collect or show home addresses, personal contact details, family information, private social media activity or other sensitive personal data.</p>
    </section>

    <section class="section prose" id="limitations" aria-labelledby="h-lim">
      <h2 id="h-lim">Limitations</h2>
      <ul>
        <li>Coverage is deliberately narrow. A smaller, accurate record is preferred to a larger, misleading one.</li>
        <li>Official sources can be incomplete, change without notice, or be taken offline. When that happens, affected claims are flagged for re-checking.</li>
        <li>Legal developments can be complex. A bill is not a law; a judgment may later be appealed, stayed, reviewed or modified. We record these as separate, linked events rather than one-line summaries.</li>
        <li>Many published claims are currently AI-checked rather than reviewed by a person; each is labelled.</li>
        <li>The publication policy and methodology have not yet been reviewed by a lawyer qualified in Indian law.</li>
      </ul>
    </section>
  </div>`;
}
