import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const PAGES = ["/", "/institutions", "/institutions/fixture-commission-a", "/institutions/fixture-commission-a/appointment",
  "/people/fixture-person-one", "/map", "/methodology", "/corrections"];

async function noHorizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

test.describe("accessibility and layout", () => {
  for (const path of PAGES) {
    test(`${path} has no serious accessibility violations and no horizontal overflow`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      expect(await noHorizontalOverflow(page)).toBe(true);
    });
  }
});

test.describe("relationship map", () => {
  test("draws exactly the published relationships and offers a list alternative", async ({ page }) => {
    await page.goto("/map");
    const data = JSON.parse((await page.locator("#graph-data").textContent())!);
    await expect(page.locator(".map-canvas svg g.edge")).toHaveCount(data.edges.length);
    await expect(page.locator(".map-canvas svg g.node")).toHaveCount(data.nodes.length);
    await expect(page.locator("[data-map-list] > li")).toHaveCount(data.edges.length);
    // 2 positions (+2 appointing-authority edges) + 3 relationships in the fixture.
    expect(data.edges.length).toBe(7);
    for (const e of data.edges) expect(e.claimId).toMatch(/^C-\d{6}$/);
  });

  test("selecting an edge shows its explanation and evidence", async ({ page, isMobile }) => {
    await page.goto("/map");
    const edge = page.locator(".map-canvas svg g.edge").first();
    await edge.scrollIntoViewIfNeeded();
    if (isMobile) await edge.dispatchEvent("click"); else await edge.click({ force: true });
    const panel = page.locator("[data-map-detail]");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("link", { name: /Full evidence record C-\d{6}/ })).toBeVisible();
    await expect(panel.getByText("Sources")).toBeVisible();
  });

  test("touch: tapping a node opens its detail panel", async ({ browser }) => {
    const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto("http://localhost:3100/map");
    const node = page.locator(".map-canvas svg g.node").first();
    await node.scrollIntoViewIfNeeded();
    const box = (await node.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 8);
    await expect(page.locator("[data-map-detail]")).toBeVisible();
    await ctx.close();
  });

  test("keyboard: a focused node opens with Enter and closes with Escape", async ({ page }) => {
    await page.goto("/map");
    const node = page.locator(".map-canvas svg g.node").first();
    await node.focus();
    await page.keyboard.press("Enter");
    const panel = page.locator("[data-map-detail]");
    await expect(panel).toBeVisible();
    await node.focus();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("hiding ended relationships updates both the graph and the list", async ({ page }) => {
    await page.goto("/map");
    const historicalCount = await page.locator(".map-canvas svg g.edge.historical").count();
    expect(historicalCount).toBeGreaterThan(0);
    await page.locator("[data-map-historical]").uncheck();
    await expect(page.locator(".map-canvas svg g.edge.historical").first()).toHaveAttribute("display", "none");
    const visibleItems = await page.locator("[data-map-list] > li:not([hidden])").count();
    expect(visibleItems).toBe(7 - historicalCount);
  });

  test("works without JavaScript through the list view", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("http://localhost:3100/map?historical=0");
    await expect(page.locator("[data-map-list] > li").first()).toBeVisible();
    await expect(page.locator(".map-canvas svg")).toHaveCount(0);
    await ctx.close();
  });
});

test.describe("institution profile", () => {
  test("shows the appointment pipeline in order with sources for each stage", async ({ page }) => {
    await page.goto("/institutions/fixture-commission-a/appointment");
    const stages = page.locator(".pipeline > li summary");
    await expect(stages).toHaveCount(3);
    await expect(stages.nth(0)).toContainText("Fixture panel shortlists");
    await expect(page.locator(".pipeline .note a.cid").first()).toHaveAttribute("href", /\/claims\/C-\d{6}/);
  });

  test("distinguishes a proposed bill from an enacted law", async ({ page }) => {
    await page.goto("/institutions/fixture-commission-a/appointment");
    await expect(page.getByText("Bill introduced (proposed, not law)")).toBeVisible();
    await expect(page.getByText("Act enacted", { exact: false }).first()).toBeVisible();
  });

  test("safeguard tiles open to show what a provision does and does not establish", async ({ page }) => {
    await page.goto("/institutions/fixture-commission-a");
    const tile = page.locator(".tile").first();
    await expect(tile.locator(".tile-body")).toBeHidden();
    await tile.locator("summary").click();
    await expect(tile.getByText("Does not establish.")).toBeVisible();
  });

  test("the appointment flow opens a stage's legal text in a panel", async ({ page }) => {
    await page.goto("/institutions/fixture-commission-a");
    await expect(page.locator(".flow .flow-step")).toHaveCount(3);
    await page.locator(".flow .flow-step").nth(1).click();
    const panel = page.locator("#appt-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("link", { name: /Evidence C-\d{6}/ })).toBeVisible();
  });

  test("never invents precision: a year-only date is shown as a year", async ({ page }) => {
    await page.goto("/people/fixture-person-one");
    await expect(page.locator(".fact-card h3", { hasText: "2018" })).toHaveText(/^2018 – March 2021$/);
    await expect(page.locator(".viz-table li").first()).toContainText("2018 to March 2021");
  });
});

test.describe("home visuals", () => {
  test("the appointment diagram draws one line per documented institution-level relationship", async ({ page }) => {
    await page.goto("/");
    const data = JSON.parse((await page.locator("#viz-data").textContent())!);
    await expect(page.locator(".web-lines .web-link")).toHaveCount(data.links.length);
    await page.locator(".web-node", { hasText: "Fixture Selection Panel" }).click();
    await expect(page.locator("#web-panel")).toBeVisible();
  });

  test("safeguard chips open their evidence; empty cells say nothing is documented, not absent", async ({ page }) => {
    await page.goto("/");
    await page.locator(".matrix .chip").first().click();
    const panel = page.locator("#matrix-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("What it does not establish")).toBeVisible();
    await expect(page.getByText(/not that no safeguard exists/)).toBeVisible();
  });

  test("the timeline plots every dated event and tenure, with tooltips or tap details", async ({ page, isMobile }) => {
    await page.goto("/");
    const data = JSON.parse((await page.locator("#viz-data").textContent())!);
    const dated = data.events.filter((e: { date: string | null }) => e.date).length;
    await expect(page.locator(".timeline-svg .tl-ev")).toHaveCount(dated);
    await expect(page.locator(".timeline-svg .tl-bar")).toHaveCount(data.tenures.filter((t: { start: string | null }) => t.start).length);
    const bar = page.locator(".timeline-svg .tl-bar rect").first();
    if (isMobile) {
      await bar.tap();
      await expect(page.locator("#home-tl-panel")).toBeVisible();
    } else {
      await bar.hover();
      await expect(page.locator(".viz-tip")).toBeVisible();
    }
  });
});
