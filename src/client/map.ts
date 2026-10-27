// Relationship map — progressive enhancement over the server-rendered list.
// Separation of concerns:
//   data (GraphData from the server, already publication-filtered)  → never mutated
//   layout (positions, in a separate Map)                           → presentation only
//   encoding (shape/line style by type)                             → drawEdge/drawNode
//   interaction (select, filter, zoom, keyboard)                    → handlers below
//   evidence (fetched per claim from the public API)                → showEdge()
import { select, type Selection } from "d3-selection";
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";

interface GraphNode { id: string; kind: string; label: string; href: string; }
interface GraphEdge {
  id: string; type: string; label: string; source: string; target: string; claimId: string;
  description: string; meaning: string; period: string; historical: boolean; checkedBy?: "human" | "ai" | null;
}
interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; }
interface LayoutNode extends SimulationNodeDatum { id: string; }

const DASH: Record<string, string> = {
  appointed_by: "", nominated_by: "6 4", selected_through: "8 3 2 3", previously_held_position_at: "1.5 4",
  served_as_member_of: "1.5 4", formally_reports_to: "12 4", has_statutory_responsibility_for: "12 4",
  has_jurisdiction_over: "12 4", participates_in_appointment_of: "8 3 2 3", subsequently_appointed_to: "1.5 4",
};
// Columns group nodes by entity type purely to keep the drawing readable. They are not a ranking.
const COLUMN: Record<string, number> = {
  government_body: 0, legislature: 0, court: 0, selection_body: 1, independent_institution: 2, person: 3,
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, attrs: Record<string, string> = {}) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Pure layout: returns positions only. It cannot add or remove relationships. */
export function computeLayout(data: GraphData, width: number, height: number): Map<string, { x: number; y: number }> {
  const nodes: LayoutNode[] = data.nodes.map((n) => ({ id: n.id }));
  const kindOf = new Map(data.nodes.map((n) => [n.id, n.kind]));
  const links = data.edges.map((e) => ({ source: e.source, target: e.target }));
  const cols = Math.max(...data.nodes.map((n) => COLUMN[n.kind] ?? 2)) + 1;
  const colX = (id: string) => ((COLUMN[kindOf.get(id) ?? ""] ?? 2) + 0.5) * (width / Math.max(cols, 1));
  const sim = forceSimulation(nodes)
    .force("link", forceLink<LayoutNode, { source: string; target: string }>(links).id((d) => d.id).distance(140).strength(0.4))
    .force("charge", forceManyBody().strength(-380))
    .force("collide", forceCollide(48))
    .force("x", forceX<LayoutNode>((d) => colX(d.id)).strength(0.35))
    .force("y", forceY(height / 2).strength(0.06))
    .stop();
  for (let i = 0; i < 320; i++) sim.tick();
  return new Map(nodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}

function init(container: HTMLElement) {
  const dataEl = document.getElementById("graph-data");
  if (!dataEl?.textContent) return;
  let data: GraphData;
  try { data = JSON.parse(dataEl.textContent) as GraphData; } catch { return; }
  const compact = container.hasAttribute("data-compact");
  const panel = document.querySelector<HTMLElement>("[data-map-detail]");
  const controls = document.querySelector<HTMLFormElement>("[data-map-controls]");
  const list = document.querySelector<HTMLElement>("[data-map-list]");
  const nodeById = new Map(data.nodes.map((n) => [n.id, n]));

  const width = 960, height = compact ? 420 : 620;
  const pos = computeLayout(data, width, height);

  const svg = select(container).append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`).attr("role", "group")
    .attr("aria-label", `Relationship map with ${data.nodes.length} entities and ${data.edges.length} documented relationships`);
  const layer = svg.append("g");

  // Fit content into view.
  const xs = [...pos.values()].map((p) => p.x), ys = [...pos.values()].map((p) => p.y);
  const pad = 80;
  const bx = Math.min(...xs) - pad, by = Math.min(...ys) - pad, bw = Math.max(...xs) - bx + pad, bh = Math.max(...ys) - by + pad;
  const k = Math.min(width / bw, height / bh, 1.8);
  const fit = zoomIdentity.translate(width / 2 - (bx + bw / 2) * k, height / 2 - (by + bh / 2) * k).scale(k);
  const zoom: ZoomBehavior<SVGSVGElement, unknown> = d3zoom<SVGSVGElement, unknown>().scaleExtent([0.3, 4])
    .on("zoom", (ev) => layer.attr("transform", ev.transform.toString()));
  (svg as unknown as Selection<SVGSVGElement, unknown, null, undefined>).call(zoom).call(zoom.transform, fit);
  svg.on("dblclick.zoom", null);

  // Parallel edges between the same pair are curved apart so none hides another.
  const pairCount = new Map<string, number>();
  const pairIndex = new Map<string, number>();
  for (const e of data.edges) {
    const key = [e.source, e.target].sort().join("|");
    pairIndex.set(e.id, pairCount.get(key) ?? 0);
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }
  function pathFor(e: GraphEdge) {
    const a = pos.get(e.source)!, b = pos.get(e.target)!;
    const key = [e.source, e.target].sort().join("|");
    const n = pairCount.get(key) ?? 1, i = pairIndex.get(e.id) ?? 0;
    const off = (i - (n - 1) / 2) * 26;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    return `M${a.x},${a.y} Q${mx - (dy / len) * off},${my + (dx / len) * off} ${b.x},${b.y}`;
  }

  const edgeG = layer.append("g").selectAll<SVGGElement, GraphEdge>("g").data(data.edges, (d) => d.id).join("g")
    .attr("class", (d) => `edge${d.historical ? " historical" : ""}`).attr("tabindex", "0").attr("role", "button")
    .attr("aria-label", (d) => `${nodeById.get(d.source)?.label} ${d.label.toLowerCase()} ${nodeById.get(d.target)?.label}. ${d.period}`);
  edgeG.append("path").attr("d", pathFor).attr("fill", "none").attr("stroke", "transparent").attr("stroke-width", 14);
  edgeG.each(function (d) {
    const g = select(this);
    if (d.type === "held_position") {
      g.append("path").attr("class", "line").attr("d", pathFor(d)).attr("fill", "none").attr("stroke", "#1d2422").attr("stroke-width", 5);
      g.append("path").attr("d", pathFor(d)).attr("fill", "none").attr("stroke", "#fbfbf9").attr("stroke-width", 2);
    } else {
      g.append("path").attr("class", "line").attr("d", pathFor(d)).attr("fill", "none").attr("stroke", "#1d2422")
        .attr("stroke-width", 1.8).attr("stroke-linecap", "round").attr("stroke-dasharray", DASH[d.type] ?? "");
    }
  });

  const nodeG = layer.append("g").selectAll<SVGGElement, GraphNode>("g").data(data.nodes, (d) => d.id).join("g")
    .attr("class", "node").attr("tabindex", "0").attr("role", "button")
    .attr("aria-label", (d) => `${d.label}, ${d.kind.replace(/_/g, " ")}`)
    .attr("transform", (d) => `translate(${pos.get(d.id)!.x},${pos.get(d.id)!.y})`);
  nodeG.each(function (d) {
    const g = select(this);
    if (d.kind === "person") g.append("circle").attr("class", "shape").attr("r", 11).attr("fill", "#fff").attr("stroke", "#1d2422").attr("stroke-width", 1.5);
    else g.append("rect").attr("class", "shape").attr("x", -12).attr("y", -12).attr("width", 24).attr("height", 24)
      .attr("fill", d.kind === "independent_institution" ? "#e9e6f4" : "#fff")
      .attr("stroke", d.kind === "independent_institution" ? "#4a3e8e" : "#1d2422").attr("stroke-width", 1.5);
    g.append("text").attr("y", 28).attr("text-anchor", "middle").text(d.label.length > 34 ? d.label.slice(0, 32) + "…" : d.label);
  });

  // ---------------------------------------------------------------- Selection and detail panel
  function clearSelection() {
    nodeG.classed("selected", false); edgeG.classed("selected", false);
    if (panel) { panel.hidden = true; panel.replaceChildren(); }
  }

  function showNode(n: GraphNode) {
    if (compact) { window.location.href = n.href; return; }
    clearSelection();
    nodeG.filter((d) => d.id === n.id).classed("selected", true);
    if (!panel) return;
    const rels = data.edges.filter((e) => (e.source === n.id || e.target === n.id) && visible(e));
    const h = el("h3", n.label);
    const link = el("p"); link.append(el("a", "Open profile", { href: n.href }));
    const ul = el("ul", undefined, { class: "legend" });
    for (const e of rels) {
      const other = nodeById.get(e.source === n.id ? e.target : e.source);
      const b = el("button", `${e.source === n.id ? e.label : "← " + e.label}: ${other?.label ?? ""}`, { type: "button", class: "button plain" });
      b.addEventListener("click", () => showEdge(e));
      const li = el("li"); li.append(b); ul.append(li);
    }
    panel.replaceChildren(h, link, el("p", `${rels.length} documented relationship${rels.length === 1 ? "" : "s"} shown.`), ul);
    panel.hidden = false;
  }

  async function showEdge(e: GraphEdge) {
    if (compact) { window.location.href = `/map#edge-${e.id}`; return; }
    clearSelection();
    edgeG.filter((d) => d.id === e.id).classed("selected", true);
    if (!panel) return;
    const s = nodeById.get(e.source)!, t = nodeById.get(e.target)!;
    const title = el("h3", `${s.label} ${e.label.toLowerCase()} ${t.label}`);
    const sources = el("div", "Loading sources…", { class: "small" });
    const evLink = el("p"); evLink.append(el("a", `Full evidence record ${e.claimId}`, { href: `/claims/${e.claimId}` }));
    panel.replaceChildren(title, el("p", e.description), el("p", e.period + (e.historical ? ". This relationship has ended." : ""), { class: "small" }),
      el("p", e.meaning, { class: "small quiet" }),
      ...(e.checkedBy === "ai" ? [el("p", "Checked by AI against its source. Not yet reviewed by a person.", { class: "small ai-line" })] : []),
      sources, evLink);
    panel.hidden = false;
    try {
      const r = await fetch(`/api/public/claims/${encodeURIComponent(e.claimId)}`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json() as { evidence: { title: string; relevant_section: string | null; canonical_url: string; evidence_role: string }[] };
      const ul = el("ul");
      for (const ev of body.evidence.filter((x) => x.evidence_role === "supports")) {
        const li = el("li");
        const a = el("a", ev.title, { href: /^https?:\/\//.test(ev.canonical_url) ? ev.canonical_url : "#", rel: "noopener noreferrer" });
        li.append(a, document.createTextNode(ev.relevant_section ? `, ${ev.relevant_section}` : ""));
        ul.append(li);
      }
      sources.replaceChildren(el("strong", "Sources"), ul);
    } catch {
      sources.textContent = "Sources could not be loaded here. Open the full evidence record instead.";
    }
  }

  const activate = <T,>(sel: Selection<SVGGElement, T, SVGGElement, unknown>, fn: (d: T) => void) => {
    sel.on("click", (ev: MouseEvent, d) => { ev.stopPropagation(); fn(d); })
      .on("keydown", (ev: KeyboardEvent, d) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fn(d); } });
  };
  activate(nodeG, showNode);
  activate(edgeG, (d) => void showEdge(d));
  svg.on("click", clearSelection);
  container.addEventListener("keydown", (ev) => { if (ev.key === "Escape") clearSelection(); });

  // ---------------------------------------------------------------- Zoom buttons
  const zoomBar = el("div", undefined, { class: "map-zoom" });
  const zb = (label: string, aria: string, fn: () => void) => {
    const b = el("button", label, { type: "button", "aria-label": aria }); b.addEventListener("click", fn); zoomBar.append(b);
  };
  const svgSel = svg as unknown as Selection<SVGSVGElement, unknown, null, undefined>;
  zb("+", "Zoom in", () => svgSel.call(zoom.scaleBy, 1.3));
  zb("−", "Zoom out", () => svgSel.call(zoom.scaleBy, 1 / 1.3));
  zb("⟲", "Reset view", () => svgSel.call(zoom.transform, fit));
  container.append(zoomBar);

  // ---------------------------------------------------------------- Filters (client-side, mirrors server filters)
  const state = { institution: "", type: "", historical: true, person: true, institutionKind: true };
  function visible(e: GraphEdge) {
    if (!state.historical && e.historical) return false;
    if (state.type && e.type !== state.type) return false;
    if (state.institution && e.source !== `i:${state.institution}` && e.target !== `i:${state.institution}`) return false;
    const kinds = [nodeById.get(e.source)?.kind, nodeById.get(e.target)?.kind];
    if (!state.person && kinds.includes("person")) return false;
    if (!state.institutionKind && kinds.some((k) => k !== "person")) return false;
    return true;
  }
  function applyFilters() {
    const shownEdges = new Set(data.edges.filter(visible).map((e) => e.id));
    const shownNodes = new Set<string>();
    for (const e of data.edges) if (shownEdges.has(e.id)) { shownNodes.add(e.source); shownNodes.add(e.target); }
    edgeG.attr("display", (d) => (shownEdges.has(d.id) ? null : "none"));
    nodeG.attr("display", (d) => {
      const kindOk = d.kind === "person" ? state.person : state.institutionKind;
      const anyFilter = state.institution || state.type || !state.historical;
      return kindOk && (!anyFilter || shownNodes.has(d.id)) ? null : "none";
    });
    list?.querySelectorAll<HTMLElement>("[data-edge]").forEach((li) => { li.hidden = !shownEdges.has(li.dataset.edge ?? ""); });
    const count = list?.previousElementSibling;
    if (count) count.textContent = `${shownEdges.size} of ${data.edges.length} relationships shown.`;
  }
  if (controls) {
    const read = () => {
      const f = new FormData(controls);
      state.institution = String(f.get("institution") ?? "");
      state.type = String(f.get("type") ?? "");
      state.historical = !!controls.querySelector<HTMLInputElement>("[data-map-historical]")?.checked;
      state.person = !!controls.querySelector<HTMLInputElement>('[data-map-kind="person"]')?.checked;
      state.institutionKind = !!controls.querySelector<HTMLInputElement>('[data-map-kind="institution"]')?.checked;
      applyFilters();
    };
    controls.addEventListener("change", read);
    controls.addEventListener("submit", (ev) => { ev.preventDefault(); read(); });
    read();
    const search = controls.querySelector<HTMLInputElement>("[data-map-search]");
    search?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const term = search.value.trim().toLowerCase();
      const hit = data.nodes.find((n) => n.label.toLowerCase().includes(term));
      if (hit) {
        showNode(hit);
        const p = pos.get(hit.id)!;
        svgSel.call(zoom.transform, zoomIdentity.translate(width / 2 - p.x * 1.5, height / 2 - p.y * 1.5).scale(1.5));
      } else if (panel) {
        panel.replaceChildren(el("p", `Nothing on the map matches “${search.value}”. Only verified entities appear.`)); panel.hidden = false;
      }
    });
  }

  // Deep link from the list: /map#edge-p12 opens that edge.
  const m = window.location.hash.match(/^#edge-(.+)$/);
  const linked = m ? data.edges.find((e) => e.id === m[1]) : undefined;
  if (linked && !compact) void showEdge(linked);
}

document.querySelectorAll<HTMLElement>("[data-map]").forEach((c) => {
  try { init(c); } catch (err) {
    c.replaceChildren(el("p", "The interactive map could not be drawn in this browser. The list below shows every relationship.", { class: "noscript-msg" }));
    console.error(err);
  }
});
