// Interactive visuals. Data comes from #viz-data (already publication-filtered on the
// server). Nothing here creates facts: it draws, highlights and opens detail panels.
import { scaleTime } from "d3-scale";
import { timeYear } from "d3-time";

interface Inst { slug: string; name: string; short: string; kind: string; kindLabel: string; category: string; }
interface Link { id: string; source: string; target: string; type: string; label: string; description: string; claimId: string; ai: boolean; }
interface Ev { institution: string | null; type: string; typeLabel: string; title: string; date: string | null; precision: string; status: string | null; claimId: string; ai: boolean; }
interface Tenure { person: string; personSlug: string; institution: string; title: string; start: string | null; startP: string; end: string | null; endP: string; claimId: string; ai: boolean; }
interface Data { institutions: Inst[]; links: Link[]; events: Ev[]; tenures: Tenure[]; today: string; }

const SVGNS = "http://www.w3.org/2000/svg";
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, attrs: Record<string, string> = {}) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
function fmt(date: string | null, p: string): string {
  if (!date || p === "unknown") return "date not established";
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  if (p === "year") return String(y);
  if (p === "month") return `${FULL_MONTHS[m - 1]} ${y}`;
  return `${d} ${FULL_MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------- Detail panels
interface Detail { kicker?: string; title: string; body?: string; body2Label?: string; body2?: string; claimId: string; ai: boolean; }

function openPanel(panel: HTMLElement, d: Detail, source?: Element) {
  const close = el("button", "Close", { type: "button", class: "viz-panel-close", "aria-label": "Close details" });
  close.addEventListener("click", () => { panel.hidden = true; panel.replaceChildren(); document.querySelectorAll(".is-selected").forEach((x) => x.classList.remove("is-selected")); });
  const parts: Node[] = [close];
  if (d.kicker) parts.push(el("p", d.kicker, { class: "viz-kicker" }));
  parts.push(el("h3", d.title));
  if (d.body) parts.push(el("p", d.body));
  if (d.body2) { const p = el("p"); p.append(el("strong", `${d.body2Label ?? ""}. `), document.createTextNode(d.body2)); parts.push(p); }
  const foot = el("p", undefined, { class: "viz-foot" });
  foot.append(el("a", `Evidence ${d.claimId}`, { href: `/claims/${d.claimId}` }));
  if (d.ai) foot.append(document.createTextNode(" "), el("span", "Checked by AI", { class: "stamp ai" }));
  parts.push(foot);
  panel.replaceChildren(...parts);
  panel.hidden = false;
  document.querySelectorAll(".is-selected").forEach((x) => x.classList.remove("is-selected"));
  source?.classList.add("is-selected");
  if (panel.getBoundingClientRect().top > window.innerHeight - 80) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function panelFor(node: Element): HTMLElement | null {
  return node.closest("figure, .section, section")?.querySelector<HTMLElement>("[data-viz-panel]") ?? document.querySelector("[data-viz-panel]");
}

document.addEventListener("click", (ev) => {
  const t = (ev.target as Element).closest<HTMLElement>("[data-detail]");
  if (!t) return;
  const panel = panelFor(t);
  if (!panel) return;
  ev.preventDefault();
  openPanel(panel, {
    kicker: t.dataset.kicker, title: t.dataset.title ?? "", body: t.dataset.body, body2Label: t.dataset.body2Label,
    body2: t.dataset.body2, claimId: t.dataset.claim ?? "", ai: t.dataset.ai === "1",
  }, t);
});

const dataEl = document.getElementById("viz-data");
const data: Data | null = dataEl?.textContent ? (JSON.parse(dataEl.textContent) as Data) : null;

// ---------------------------------------------------------------- Who appoints whom
function appointmentWeb(fig: HTMLElement, d: Data) {
  const canvas = fig.querySelector<HTMLElement>("[data-web-canvas]")!;
  const panel = fig.querySelector<HTMLElement>("[data-viz-panel]")!;
  const focus = fig.dataset.focus ?? "";
  if (focus) d = { ...d, links: d.links.filter((l) => l.source === focus || l.target === focus) };
  const used = new Set(d.links.flatMap((l) => [l.source, l.target]));
  const nodes = d.institutions.filter((i) => used.has(i.slug));
  const right = nodes.filter((n) => n.kind === "independent_institution");
  // Order the left column by the average position of each body's targets (fewer crossings).
  const rIndex = new Map(right.map((n, i) => [n.slug, i]));
  const bary = (slug: string) => {
    const ix = d.links.filter((l) => l.source === slug || l.target === slug)
      .map((l) => rIndex.get(l.source === slug ? l.target : l.source)).filter((v): v is number => v !== undefined);
    return ix.length ? ix.reduce((a, b) => a + b, 0) / ix.length : 0;
  };
  const left = nodes.filter((n) => n.kind !== "independent_institution").sort((a, b) => bary(a.slug) - bary(b.slug) || a.short.localeCompare(b.short));
  if (!left.length || !right.length) return;
  const tenureCount = (slug: string) => d.tenures.filter((t) => t.institution === slug).length;

  const wrap = el("div", undefined, { class: "web-grid" });
  const colL = el("div", undefined, { class: "web-col web-col-left" });
  const colR = el("div", undefined, { class: "web-col web-col-right" });
  colL.append(el("p", "Appointing and recommending bodies", { class: "web-col-title" }));
  colR.append(el("p", "Independent institutions", { class: "web-col-title" }));
  const nodeEls = new Map<string, HTMLButtonElement>();
  const mk = (n: Inst, side: "l" | "r") => {
    const b = el("button", undefined, { type: "button", class: `web-node web-node-${side}`, "data-slug": n.slug });
    b.append(el("span", n.short, { class: "web-node-name" }), el("span", side === "r" ? n.category : n.kindLabel, { class: "web-node-kind" }));
    if (side === "r" && tenureCount(n.slug)) b.append(el("span", `${tenureCount(n.slug)} documented tenure${tenureCount(n.slug) === 1 ? "" : "s"}`, { class: "web-node-meta" }));
    nodeEls.set(n.slug, b);
    return b;
  };
  left.forEach((n) => colL.append(mk(n, "l")));
  right.forEach((n) => colR.append(mk(n, "r")));
  const lines = svg("svg", { class: "web-lines", "aria-hidden": "true" });
  wrap.append(lines, colL, el("div", undefined, { class: "web-gap" }), colR);
  canvas.replaceChildren(wrap);

  const linkEls = new Map<string, SVGGElement>();
  function draw() {
    lines.replaceChildren();
    const box = wrap.getBoundingClientRect();
    lines.setAttribute("width", String(box.width));
    lines.setAttribute("height", String(box.height));
    const defs = svg("defs");
    const marker = svg("marker", { id: "web-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    marker.append(svg("path", { d: "M0,0 L10,5 L0,10 z", fill: "currentColor" }));
    defs.append(marker);
    lines.append(defs);
    // Several relationships between the same pair are fanned apart so none hides another.
    const pairKey = (l: Link) => [l.source, l.target].sort().join("|");
    const pairTotal = new Map<string, number>();
    d.links.forEach((l) => pairTotal.set(pairKey(l), (pairTotal.get(pairKey(l)) ?? 0) + 1));
    const pairSeen = new Map<string, number>();
    for (const l of d.links) {
      const k = pairKey(l);
      const idx = pairSeen.get(k) ?? 0; pairSeen.set(k, idx + 1);
      const off = (idx - ((pairTotal.get(k) ?? 1) - 1) / 2) * 12;
      const a = nodeEls.get(l.source), b = nodeEls.get(l.target);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const aLeft = a.classList.contains("web-node-l");
      const [p, q] = aLeft ? [ra, rb] : [rb, ra];
      const x1 = p.right - box.left, y1 = p.top + p.height / 2 - box.top + off;
      const x2 = q.left - box.left, y2 = q.top + q.height / 2 - box.top + off;
      const mx = (x1 + x2) / 2;
      const dPath = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
      const g = svg("g", { class: `web-link web-link-${l.type}`, "data-id": l.id });
      const vis = svg("path", { d: dPath, class: "web-link-line" });
      // Arrowhead always points at the relationship's target.
      vis.setAttribute(aLeft ? "marker-end" : "marker-start", "url(#web-arrow)");
      const hit = svg("path", { d: dPath, class: "web-link-hit" });
      hit.addEventListener("click", () => showLink(l, g));
      hit.addEventListener("mouseenter", () => highlight([l.source, l.target], [l.id]));
      hit.addEventListener("mouseleave", () => highlight(null));
      g.append(vis, hit);
      lines.append(g);
      linkEls.set(l.id, g);
    }
  }
  const name = (s: string) => d.institutions.find((i) => i.slug === s)?.short ?? s;
  function showLink(l: Link, g?: Element) {
    openPanel(panel, { kicker: l.label, title: `${name(l.source)} → ${name(l.target)}`, body: l.description, claimId: l.claimId, ai: l.ai }, g);
  }
  function highlight(slugs: string[] | null, linkIds: string[] = []) {
    wrap.classList.toggle("has-focus", !!slugs);
    nodeEls.forEach((b, s) => b.classList.toggle("is-lit", !!slugs?.includes(s)));
    linkEls.forEach((g, id) => g.classList.toggle("is-lit", linkIds.includes(id)));
  }
  nodeEls.forEach((b, slug) => {
    const mine = d.links.filter((l) => l.source === slug || l.target === slug);
    const focus = () => highlight([slug, ...mine.flatMap((l) => [l.source, l.target])], mine.map((l) => l.id));
    b.addEventListener("mouseenter", focus);
    b.addEventListener("focus", focus);
    b.addEventListener("mouseleave", () => highlight(null));
    b.addEventListener("blur", () => highlight(null));
    b.addEventListener("click", () => {
      const inst = d.institutions.find((i) => i.slug === slug)!;
      const close = el("button", "Close", { type: "button", class: "viz-panel-close" });
      close.addEventListener("click", () => { panel.hidden = true; });
      const list = el("ul", undefined, { class: "viz-list" });
      for (const l of mine) {
        const btn = el("button", `${l.label}: ${name(l.source === slug ? l.target : l.source)}`, { type: "button", class: "link-button" });
        if (l.target === slug && l.type !== "formally_reports_to") btn.textContent = `${name(l.source)} ${l.label.toLowerCase()} it`;
        btn.addEventListener("click", () => showLink(l, linkEls.get(l.id)));
        const li = el("li"); li.append(btn); list.append(li);
      }
      const prof = el("p", undefined, { class: "viz-foot" });
      prof.append(el("a", `Open the ${inst.short} profile`, { href: `/institutions/${slug}` }));
      panel.replaceChildren(close, el("p", inst.category, { class: "viz-kicker" }), el("h3", inst.name), list, prof);
      panel.hidden = false;
    });
  });
  draw();
  new ResizeObserver(() => draw()).observe(wrap);
}

// ---------------------------------------------------------------- Timeline
function timelineViz(fig: HTMLElement, d: Data) {
  const canvas = fig.querySelector<HTMLElement>("[data-timeline-canvas]")!;
  const panel = fig.querySelector<HTMLElement>("[data-viz-panel]")!;
  const instFilter = (fig.dataset.filterInstitutions ?? "").split(",").filter(Boolean);
  const person = fig.dataset.filterPerson ?? "";
  const events = person ? [] : d.events.filter((e) => e.date && (!instFilter.length || (e.institution && instFilter.includes(e.institution))));
  const tenures = d.tenures.filter((t) => t.start && (!instFilter.length || instFilter.includes(t.institution)) && (!person || t.personSlug === person));
  if (!events.length && !tenures.length) { canvas.replaceChildren(el("p", "No dated items are published yet.", { class: "quiet small" })); return; }

  const lanes = [...new Set([...events.map((e) => e.institution ?? ""), ...tenures.map((t) => t.institution)])];
  const instName = (s: string) => d.institutions.find((i) => i.slug === s)?.short ?? "Other";
  const parse = (s: string) => new Date(`${s}T00:00:00Z`);
  const today = parse(d.today);
  const dates = [...events.map((e) => parse(e.date!)), ...tenures.map((t) => parse(t.start!)), today];
  const min = new Date(Math.min(...dates.map(Number))), max = today;
  const start = new Date(Date.UTC(min.getUTCFullYear(), 0, 1));
  const end = new Date(Date.UTC(max.getUTCFullYear(), 11, 31));

  const tip = el("div", undefined, { class: "viz-tip", role: "tooltip" });
  tip.hidden = true;

  function draw() {
    const width = Math.max(canvas.clientWidth, 320);
    const narrow = width < 560;
    const labelW = narrow ? 0 : 84, padR = 16, axisH = 26;
    const x = scaleTime().domain([start, end]).range([labelW + 8, width - padR]);
    const laneRows = lanes.map((lane) => ({ lane, tenures: tenures.filter((t) => t.institution === lane), events: events.filter((e) => (e.institution ?? "") === lane) }));
    const rowH = narrow ? 36 : 26, evRowH = 34, laneGap = narrow ? 30 : 18;
    let y = axisH + 6;
    const layout = laneRows.map((l) => {
      const top = y;
      const evY = l.events.length ? y + evRowH / 2 : 0;
      y += (l.events.length ? evRowH : 0) + l.tenures.length * rowH + laneGap;
      return { ...l, top, evY };
    });
    const height = y;
    const root = svg("svg", { width, height, class: "timeline-svg", role: "group", "aria-label": "Timeline of documented legal events and tenures" });

    // Year grid + axis
    for (const yr of timeYear.range(start, new Date(+end + 1))) {
      const gx = x(yr);
      root.append(svg("line", { x1: gx, x2: gx, y1: axisH, y2: height - 8, class: "tl-grid" }));
      const showLabel = !narrow || yr.getUTCFullYear() % 2 === 0;
      if (showLabel) { const t = svg("text", { x: gx + 3, y: 14, class: "tl-axis" }); t.textContent = String(yr.getUTCFullYear()); root.append(t); }
    }
    const tx = x(today);
    root.append(svg("line", { x1: tx, x2: tx, y1: axisH - 4, y2: height - 8, class: "tl-today" }));
    const tt = svg("text", { x: tx - 3, y: axisH - 8, class: "tl-axis tl-today-label", "text-anchor": "end" }); tt.textContent = "Today"; root.append(tt);

    const hover = (target: SVGElement, text: string[], detail: Detail) => {
      target.setAttribute("tabindex", "0");
      target.setAttribute("role", "button");
      target.setAttribute("aria-label", text.join(". "));
      const show = (cx: number, cy: number) => {
        tip.replaceChildren(...text.map((s, i) => el(i === 0 ? "strong" : "span", s)));
        tip.hidden = false;
        const cb = canvas.getBoundingClientRect();
        const left = Math.min(Math.max(cx - cb.left + 12, 4), cb.width - 240);
        tip.style.left = `${left}px`; tip.style.top = `${cy - cb.top + 14}px`;
      };
      target.addEventListener("mousemove", (ev) => show((ev as MouseEvent).clientX, (ev as MouseEvent).clientY));
      target.addEventListener("mouseleave", () => { tip.hidden = true; });
      target.addEventListener("focus", () => { const r = target.getBoundingClientRect(); show(r.left + r.width / 2, r.bottom); });
      target.addEventListener("blur", () => { tip.hidden = true; });
      const act = () => { tip.hidden = true; openPanel(panel, detail, target); };
      target.addEventListener("click", act);
      target.addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter" || (ev as KeyboardEvent).key === " ") { ev.preventDefault(); act(); } });
    };

    for (const L of layout) {
      if (narrow) { const t = svg("text", { x: 2, y: L.top - 6, class: "tl-lane" }); t.textContent = instName(L.lane); root.append(t); }
      else { const t = svg("text", { x: 0, y: L.top + 14, class: "tl-lane" }); t.textContent = instName(L.lane); root.append(t); }
      root.append(svg("line", { x1: labelW + 8, x2: width - padR, y1: L.top - 4, y2: L.top - 4, class: "tl-lane-rule" }));
      // Events: stagger markers that would overlap.
      let lastX = -99, flip = false;
      for (const e of [...L.events].sort((a, b) => a.date!.localeCompare(b.date!))) {
        const ex = x(parse(e.date!));
        flip = ex - lastX < 14 ? !flip : false; lastX = ex;
        const ey = L.evY + (flip ? 8 : 0);
        const shape = e.type === "judgment" || e.type === "interim_order"
          ? svg("rect", { x: ex - 6, y: ey - 6, width: 12, height: 12, transform: `rotate(45 ${ex} ${ey})`, class: "tl-ev" })
          : e.type.includes("act") || e.type.includes("amendment") || e.type === "bill_passed"
            ? svg("circle", { cx: ex, cy: ey, r: 7, class: "tl-ev" })
            : svg("rect", { x: ex - 6, y: ey - 6, width: 12, height: 12, rx: 2, class: "tl-ev tl-ev-open" });
        root.append(shape);
        hover(shape, [e.title, `${e.typeLabel}, ${fmt(e.date, e.precision)}`, ...(e.ai ? ["Checked by AI"] : [])],
          { kicker: `${e.typeLabel}, ${fmt(e.date, e.precision)}`, title: e.title, body: e.status ?? "", claimId: e.claimId, ai: e.ai });
      }
      // Tenures as bars; an open end is drawn to today with a fading, dashed tail.
      L.tenures.sort((a, b) => a.start!.localeCompare(b.start!)).forEach((t, i) => {
        const ty = L.top + (L.events.length ? evRowH : 0) + i * rowH + (narrow ? 16 : 4);
        const x1 = x(parse(t.start!));
        const known = !!t.end && t.endP !== "unknown";
        const x2 = known ? x(parse(t.end!)) : x(today);
        const g = svg("g", { class: `tl-bar${known ? "" : " tl-open"}` });
        g.append(svg("rect", { x: x1, y: ty, width: Math.max(x2 - x1, 4), height: 16, rx: 4 }));
        if (!known) g.append(svg("line", { x1: x2, x2: x2, y1: ty - 2, y2: ty + 18, class: "tl-open-end" }));
        const label = `${t.person}, ${t.title}`;
        const textW = label.length * 6.4 + 12;
        let tl: SVGTextElement;
        if (x2 - x1 > textW) tl = svg("text", { x: x1 + 8, y: ty + 12, class: "tl-bar-label in" });
        else if (narrow) tl = svg("text", { x: Math.max(Math.min(x1, width - padR - textW), 2), y: ty - 4, class: "tl-bar-label" });
        else if (x2 + 6 + textW < width) tl = svg("text", { x: x2 + 6, y: ty + 12, class: "tl-bar-label" });
        else tl = svg("text", { x: Math.max(x1 - 6, labelW + 8 + textW), y: ty + 12, class: "tl-bar-label", "text-anchor": "end" });
        tl.textContent = label;
        g.append(tl);
        root.append(g);
        hover(g, [label, `${fmt(t.start, t.startP)} to ${known ? fmt(t.end, t.endP) : "end not established"}`, ...(t.ai ? ["Checked by AI"] : [])],
          { kicker: `${fmt(t.start, t.startP)} to ${known ? fmt(t.end, t.endP) : "end not established"}`, title: label, body: known ? "" : "No source reviewed establishes when this tenure ended, so the bar runs to today and is drawn open.", claimId: t.claimId, ai: t.ai });
      });
    }
    canvas.replaceChildren(root, tip);
  }

  // Legend
  const legend = el("ul", undefined, { class: "tl-legend" });
  const item = (cls: string, text: string) => { const li = el("li"); const s = el("span", undefined, { class: `tl-key ${cls}` }); li.append(s, document.createTextNode(text)); legend.append(li); };
  if (events.some((e) => e.type === "judgment")) item("k-judgment", "Judgment");
  if (events.some((e) => e.type.includes("act") || e.type.includes("amendment"))) item("k-act", "Law enacted or amended");
  if (events.some((e) => !(e.type === "judgment" || e.type.includes("act") || e.type.includes("amendment")))) item("k-other", "Other legal step");
  if (tenures.some((t) => t.end)) item("k-bar", "Tenure");
  if (tenures.some((t) => !t.end)) item("k-open", "End not established");
  fig.insertBefore(legend, canvas);

  draw();
  let w = canvas.clientWidth;
  new ResizeObserver(() => { if (Math.abs(canvas.clientWidth - w) > 4) { w = canvas.clientWidth; draw(); } }).observe(canvas);
}

if (data) {
  document.querySelectorAll<HTMLElement>("[data-web]").forEach((f) => { try { appointmentWeb(f, data); } catch (e) { console.error(e); } });
  document.querySelectorAll<HTMLElement>("[data-timeline]").forEach((f) => { try { timelineViz(f, data); } catch (e) { console.error(e); } });
}
