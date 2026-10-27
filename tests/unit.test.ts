import { describe, it, expect } from "vitest";
import { buildGraph } from "../src/public/graph.js";
import { formatDated, formatRange } from "../src/lib/dates.js";
import { parseDated, isHttpUrl } from "../src/lib/validate.js";
import { html, safeHref, jsonForScript, raw } from "../src/lib/html.js";
import { languageWarnings } from "../src/editorial/language.js";
import type { Institution, Person, Position, Relationship } from "../src/public/queries.js";

const inst = (slug: string, kind = "independent_institution"): Institution => ({
  id: slug.length, slug, canonical_name: `Test ${slug}`, short_name: null, entity_kind: kind, legal_category: "statutory_body",
  official_website: null, last_verified_at: null, published_claim_count: "1" });
const person = (slug: string): Person => ({ id: slug.length, slug, canonical_name: `Test ${slug}`, last_verified_at: null });

describe("graph builder", () => {
  const institutions = [inst("alpha"), inst("gov", "government_body")];
  const people = [person("p-one")];
  const positions: Position[] = [{
    id: 1, claim_id: "C-000010", person_id: 1, person_slug: "p-one", person_name: "Test p-one", institution_id: 1,
    institution_slug: "alpha", institution_name: "Test alpha", institution_kind: "independent_institution", title: "Test Member",
    start_date: "2019-01-01", start_precision: "year", end_date: "2021-06-01", end_precision: "month", ongoing_as_of: null,
    appointment_type: "appointed", appointing_authority_id: 2, appointing_authority_slug: "gov", appointing_authority_name: "Test gov" }];
  const relationships: Relationship[] = [
    { id: 7, claim_id: "C-000011", relationship_type: "formally_reports_to", description: "Test.", source_type: "institution", source_id: 1,
      source_slug: "alpha", source_name: "Test alpha", target_type: "institution", target_id: 2, target_slug: "gov", target_name: "Test gov",
      valid_from: null, valid_from_precision: "unknown", valid_until: null, valid_until_precision: "unknown" },
    // Endpoint not in the public entity list: must not be drawn.
    { id: 8, claim_id: "C-000012", relationship_type: "appointed_by", description: "Test.", source_type: "person", source_id: 9,
      source_slug: "unpublished-person", source_name: "x", target_type: "institution", target_id: 2, target_slug: "gov", target_name: "Test gov",
      valid_from: null, valid_from_precision: "unknown", valid_until: null, valid_until_precision: "unknown" },
  ];
  const g = buildGraph({ institutions, people, positions, relationships }, "2026-10-27");

  it("creates edges only from records, each with a claim ID", () => {
    expect(g.edges.map((e) => e.id).sort()).toEqual(["p1", "pa1", "r7"]);
    for (const e of g.edges) expect(e.claimId).toMatch(/^C-\d{6}$/);
  });
  it("never draws an edge to an entity that is not public", () => {
    expect(g.edges.find((e) => e.id === "r8")).toBeUndefined();
    expect(g.nodes.find((n) => n.id === "p:unpublished-person")).toBeUndefined();
  });
  it("marks ended relationships as historical using their dates", () => {
    expect(g.edges.find((e) => e.id === "p1")!.historical).toBe(true);
    expect(g.edges.find((e) => e.id === "r7")!.historical).toBe(false);
  });
  it("uses neutral wording for appointment edges", () => {
    const e = g.edges.find((x) => x.id === "pa1")!;
    expect(e.meaning).toMatch(/does not, by itself, establish political influence/);
  });
});

describe("dates never gain precision", () => {
  it("formats at stored precision", () => {
    expect(formatDated("2019-01-01", "year")).toBe("2019");
    expect(formatDated("2019-08-01", "month")).toBe("August 2019");
    expect(formatDated("2019-08-01", "day")).toBe("1 August 2019");
    expect(formatDated(null, "unknown")).toBe("Date not established");
    expect(formatRange("2019-01-01", "year", null, "unknown")).toBe("2019 – end date not established");
    expect(formatRange(null, "unknown", null, "unknown")).toBe("Dates not established");
  });
  it("parses input honestly", () => {
    expect(parseDated("2019")).toEqual({ date: "2019-01-01", precision: "year" });
    expect(parseDated("2019-08")).toEqual({ date: "2019-08-01", precision: "month" });
    expect(parseDated("")).toEqual({ date: null, precision: "unknown" });
    expect("error" in parseDated("2019-02-30")).toBe(true);
    expect("error" in parseDated("Aug 2019")).toBe(true);
  });
});

describe("output safety", () => {
  it("escapes interpolated values", () => {
    expect(html`<p>${"<img src=x onerror=alert(1)>"}</p>`.value).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(html`<a title="${'" onmouseover="x'}">`.value).not.toContain('" onmouseover');
    expect(html`${raw("<b>ok</b>")}`.value).toBe("<b>ok</b>");
  });
  it("only allows http(s) or relative hrefs", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("//evil.example")).toBe("#");
    expect(safeHref("/claims/C-000001")).toBe("/claims/C-000001");
    expect(safeHref("https://example.org/a")).toBe("https://example.org/a");
    expect(isHttpUrl("data:text/html,x")).toBe(false);
  });
  it("embeds JSON without allowing </script> breakout", () => {
    expect(jsonForScript({ a: "</script><script>alert(1)</script>" }).value).not.toContain("</script>");
  });
  it("flags inflammatory labels for reviewers", () => {
    expect(languageWarnings("The commissioner is a government puppet.")).toHaveLength(1);
    expect(languageWarnings("The President appoints the Commissioner.")).toHaveLength(0);
  });
});
