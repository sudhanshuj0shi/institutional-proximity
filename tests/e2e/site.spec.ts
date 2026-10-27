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
    await page.goto("/institutions/fixture-commission-a#history");
    await expect(page.getByText("Bill introduced (proposed, not law)")).toBeVisible();
    await expect(page.getByText("Act enacted", { exact: false }).first()).toBeVisible();
  });

  test("filters safeguards in place", async ({ page }) => {
    await page.goto("/institutions/fixture-commission-a");
    await page.locator('[data-safeguard-filter] a[data-dim="tenure"]').click();
    await expect(page.locator('[data-dimension="removal"]')).toBeHidden();
    await expect(page.locator('[data-dimension="tenure"]')).toBeVisible();
  });

  test("never invents precision: a year-only date is shown as a year", async ({ page }) => {
    await page.goto("/people/fixture-person-one");
    await expect(page.locator(".timeline .when").first()).toHaveText(/^2018 – March 2021/);
  });
});
