// Server-rendered visual components. Each works without JavaScript (links, lists,
// <details>); src/client/viz.ts adds hover, detail panels and the drawn diagrams.
import { html, jsonForScript, SafeHtml } from "../lib/html.js";
import { formatDated } from "../lib/dates.js";
import type { VizData, VizSafeguard, VizStage } from "./visual-data.js";

// Simple line icons, one per safeguard dimension (24px grid, stroke = currentColor).
const ICON: Record<string, string> = {
  appointment: "M12 3v6m0 0l-3-3m3 3l3-3M5 13h14l-1.5 8h-11z",
  tenure: "M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9",
  removal: "M5 12h11m0 0l-4-4m4 4l-4 4M19 4v16",
  conditions_of_service: "M12 4v16M5 8h14M5 8l-2 6h4zM19 8l-2 6h4zM8 20h8",
  financial: "M4 7h16v10H4zM12 9.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM4 10h2M18 14h2",
  operational_autonomy: "M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z",
  transparency: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 110 6 3 3 0 010-6z",
  accountability: "M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7",
};
export function icon(dim: string, size = 22): SafeHtml {
  const d = ICON[dim] ?? ICON.accountability!;
  return html`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Attributes that let viz.ts open a detail panel; without JS the element is a plain link. */
function detailAttrs(o: { title: string; kicker?: string; body?: string; body2Label?: string; body2?: string; claimId: string; ai: boolean }) {
  return html`data-detail data-title="${o.title}" data-kicker="${o.kicker ?? ""}" data-body="${o.body ?? ""}" data-body2-label="${o.body2Label ?? ""}" data-body2="${o.body2 ?? ""}" data-claim="${o.claimId}" data-ai="${o.ai ? "1" : ""}"`;
}

export function detailPanel(id: string): SafeHtml {
  return html`<div class="viz-panel" id="${id}" data-viz-panel hidden aria-live="polite"></div>`;
}

export function vizData(data: VizData): SafeHtml {
  return html`<script type="application/json" id="viz-data">${jsonForScript(data)}</script>`;
}

// ---------------------------------------------------------------- Stat strip
export function statStrip(items: { value: string | number; label: string }[]): SafeHtml {
  return html`<dl class="stats">${items.map((i) => html`<div><dt>${i.label}</dt><dd>${i.value}</dd></div>`)}</dl>`;
}

// ---------------------------------------------------------------- Who appoints whom
export function appointmentWeb(data: VizData, focus?: string): SafeHtml {
  const name = new Map(data.institutions.map((i) => [i.slug, i.short]));
  const links = focus ? data.links.filter((l) => l.source === focus || l.target === focus) : data.links;
  return html`<figure class="web" data-web data-focus="${focus ?? ""}">
    <div class="web-canvas" data-web-canvas>
      <noscript><ul class="web-fallback">${links.map((l) => html`<li>${name.get(l.source)} ${l.label.toLowerCase()} ${name.get(l.target)} <a href="/claims/${l.claimId}">${l.claimId}</a></li>`)}</ul></noscript>
    </div>
    <figcaption class="viz-caption">Lines show documented appointment roles and reporting channels. Select a body or a line to see what the law says.</figcaption>
    ${detailPanel("web-panel")}
  </figure>`;
}

// ---------------------------------------------------------------- Safeguards matrix
export function safeguardMatrix(data: VizData, slugs: string[]): SafeHtml {
  const insts = slugs.map((s) => data.institutions.find((i) => i.slug === s)).filter((x): x is NonNullable<typeof x> => !!x);
  const cell = (inst: string, dim: string) => data.safeguards.filter((s) => s.institution === inst && s.dimension === dim);
  const rows = data.dimensions.filter((d) => insts.some((i) => cell(i.slug, d.key).length));
  const emptyRows = data.dimensions.filter((d) => !rows.includes(d));
  return html`<div class="matrix-wrap">
    <table class="matrix">
      <caption class="visually-hidden">Documented safeguards by institution and type</caption>
      <thead><tr><th scope="col"><span class="visually-hidden">Safeguard</span></th>
        ${insts.map((i) => html`<th scope="col"><a href="/institutions/${i.slug}">${i.short}</a><span>${i.category}</span></th>`)}</tr></thead>
      <tbody>${rows.map((d) => html`<tr>
        <th scope="row">${icon(d.key, 18)}<span>${d.label}</span></th>
        ${insts.map((i) => {
          const items = cell(i.slug, d.key);
          return items.length === 0
            ? html`<td class="gap" data-label="${i.short}"><span class="gap-mark" title="Not documented here yet"><span class="visually-hidden">Not documented yet</span></span></td>`
            : html`<td data-label="${i.short}">${items.map((s) => sgChip(s, i.short))}</td>`;
        })}</tr>`)}</tbody>
    </table>
  </div>
  <p class="viz-caption">Each chip is a provision documented with its source; select one to read it. A dash means nothing is documented here yet, not that no safeguard exists. This is not a score.${emptyRows.length ? html` Not yet documented for any institution: ${emptyRows.map((d) => d.label.toLowerCase()).join(", ")}.` : ""}</p>
  ${detailPanel("matrix-panel")}`;
}

function sgChip(s: VizSafeguard, inst: string) {
  return html`<a class="chip${s.ai ? " ai" : ""}" href="/claims/${s.claimId}" ${detailAttrs({
    title: `${inst}: ${s.provision}`, kicker: s.dimensionLabel, body: s.establishes, body2Label: "What it does not establish", body2: s.doesNot, claimId: s.claimId, ai: s.ai,
  })}>${s.provision}</a>`;
}

// ---------------------------------------------------------------- Timeline
export function timeline(data: VizData, opts: { institutions?: string[]; person?: string; id: string }): SafeHtml {
  const evs = data.events.filter((e) => (!opts.institutions || (e.institution && opts.institutions.includes(e.institution))) && !opts.person);
  const ts = data.tenures.filter((t) => (!opts.institutions || opts.institutions.includes(t.institution)) && (!opts.person || t.personSlug === opts.person));
  const undated = [...evs.filter((e) => !e.date), ...ts.filter((t) => !t.start)];
  return html`<figure class="timeline-viz" data-timeline="${opts.id}" data-filter-institutions="${(opts.institutions ?? []).join(",")}" data-filter-person="${opts.person ?? ""}">
    <div class="timeline-canvas" data-timeline-canvas></div>
    <details class="viz-table"><summary>Show as a list</summary>
      <ul>${evs.filter((e) => e.date).map((e) => html`<li>${formatDated(e.date, e.precision as "day")}: ${e.typeLabel}. ${e.title} <a href="/claims/${e.claimId}">${e.claimId}</a></li>`)}
        ${ts.map((t) => html`<li>${t.person}, ${t.title}: ${t.start ? formatDated(t.start, t.startP as "day") : "start not established"} to ${t.end ? formatDated(t.end, t.endP as "day") : "end not established"} <a href="/claims/${t.claimId}">${t.claimId}</a></li>`)}</ul>
      ${undated.length ? html`<p class="small">${undated.length} item(s) have no established date and are not plotted.</p>` : ""}
    </details>
    ${detailPanel(`${opts.id}-panel`)}
  </figure>`;
}

// ---------------------------------------------------------------- Appointment flow (institution page)
export function pipelineFlow(stages: VizStage[], processTitle: string): SafeHtml {
  return html`<ol class="flow" aria-label="${processTitle}: stages">
    ${stages.map((s, i) => html`<li>
      <a class="flow-step${s.ai ? " ai" : ""}" href="/claims/${s.claimId}" ${detailAttrs({
        title: s.title, kicker: `Stage ${s.seq}${s.provision ? `, ${s.provision}` : ""}`, body: s.role, claimId: s.claimId, ai: s.ai,
      })}>
        <span class="flow-num">${s.seq}</span>
        <span class="flow-title">${s.title}</span>
        <span class="flow-actor">${s.actor}</span>
      </a>${i < stages.length - 1 ? html`<span class="flow-arrow" aria-hidden="true"></span>` : ""}
    </li>`)}
  </ol>`;
}

// ---------------------------------------------------------------- Safeguard tiles (institution page)
export function safeguardTiles(sgs: VizSafeguard[]): SafeHtml {
  return html`<div class="tiles">${sgs.map((s) => html`<details class="tile${s.ai ? " ai" : ""}">
    <summary>${icon(s.dimension, 26)}<span class="tile-dim">${s.dimensionLabel}</span><span class="tile-prov">${s.provision}</span></summary>
    <div class="tile-body">
      <p><strong>Establishes.</strong> ${s.establishes}</p>
      <p><strong>Does not establish.</strong> ${s.doesNot}</p>
      <p class="small"><a href="/claims/${s.claimId}">Evidence ${s.claimId}</a>${s.ai ? html` <span class="stamp ai">Checked by AI</span>` : ""}</p>
    </div>
  </details>`)}</div>`;
}
