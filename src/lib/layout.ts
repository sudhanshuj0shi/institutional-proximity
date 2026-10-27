import { html, SafeHtml } from "./html.js";

export interface PageOptions {
  title: string;
  description: string;
  path: string;
  body: SafeHtml;
  scripts?: string[];
  noindex?: boolean;
  editorial?: { username: string; roles: string[] } | null;
  section?: "home" | "institutions" | "map" | "methodology" | "corrections" | "editorial";
}

const SITE = "Institutional Proximity";

let siteNotice: { ai: number; total: number } | null = null;
/** Set by the public router from site_status; drives the AI-checked disclosure banner. */
export function setSiteNotice(n: { ai: number; total: number } | null) { siteNotice = n; }

function navLink(href: string, text: string, current: boolean) {
  return html`<a href="${href}"${current ? html` aria-current="page"` : ""}>${text}</a>`;
}

export function page(o: PageOptions): SafeHtml {
  const fullTitle = o.path === "/" ? `${SITE} — Evidence on India's independent institutions` : `${o.title} | ${SITE}`;
  const ed = o.section === "editorial";
  return html`<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${o.description}">
${o.noindex || ed ? html`<meta name="robots" content="noindex, nofollow">` : ""}
<meta property="og:title" content="${o.title}">
<meta property="og:description" content="${o.description}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE}">
<link rel="stylesheet" href="/static/css/site.css">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
</head>
<body class="${ed ? "is-editorial" : ""}">
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="site-header-inner">
    <a class="wordmark" href="/">Institutional Proximity</a>
    <nav aria-label="Main">
      ${navLink("/institutions", "Institutions", o.section === "institutions")}
      ${navLink("/map", "Relationship map", o.section === "map")}
      ${navLink("/methodology", "Methodology", o.section === "methodology")}
      ${navLink("/corrections", "Corrections", o.section === "corrections")}
      ${o.editorial ? navLink("/editorial", "Editorial desk", ed) : ""}
    </nav>
  </div>
</header>
${siteNotice && !ed ? html`<div class="site-notice" role="note"><p><strong>${siteNotice.ai} of ${siteNotice.total}</strong> published ${siteNotice.total === 1 ? "claim was" : "claims were"} checked against ${siteNotice.total === 1 ? "its" : "their"} sources by an AI system and ${siteNotice.ai === 1 ? "has" : "have"} not yet been reviewed by a person. Each is labelled "Checked by AI". <a href="/methodology#checking">How checking works</a></p></div>` : ""}
<main id="main" tabindex="-1">
${o.body}
</main>
<footer class="site-footer">
  <div class="site-footer-inner">
    <p>Every statement on this site is linked to the record that supports it. A documented relationship is not, by itself, evidence of improper influence.</p>
    <p><a href="/methodology">How we verify</a> <a href="/corrections">Report an error</a></p>
  </div>
</footer>
${(o.scripts ?? []).map((s) => html`<script src="${s}" defer></script>`)}
</body>
</html>`;
}
