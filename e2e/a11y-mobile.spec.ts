import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, autoDismissLowBalance, signupViaApi } from "./helpers";

// Accessibility (axe, WCAG 2.1 A/AA) and a 390 px mobile screen: no horizontal scroll, every control has an accessible name.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const PAGES = ["/", "/signup", "/docs", "/enterprise", "/dashboard", "/billing", "/keys", "/billing/invoices/draft-current"];

test.beforeEach(async ({ page }) => { await autoDismissLowBalance(page); });

for (const path of PAGES) {
  test(`390 px + axe: ${path}`, async ({ page }) => {
    await signupViaApi(page, "pro");
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("main")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "horizontal scroll").toBeLessThanOrEqual(1);
    const unnamed = await page.locator("input:visible, select:visible, textarea:visible, button:visible").evaluateAll(els =>
      els.filter(el => {
        const e = el as HTMLInputElement;
        const byLabel = e.labels && e.labels.length > 0;
        const aria = e.getAttribute("aria-label") || e.getAttribute("aria-labelledby");
        const text = e.tagName === "BUTTON" && e.textContent?.trim();
        return !(byLabel || aria || text);
      }).map(el => el.outerHTML.slice(0, 80)));
    expect(unnamed, "controls without an accessible name").toEqual([]);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const serious = r.violations.filter(v => v.impact === "serious" || v.impact === "critical");
    expect(serious.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
}

test("390 px + axe: support panel", async ({ page }) => {
  await signupViaApi(page, "free");
  await page.goto("/admin");
  await page.getByLabel("Support password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link").filter({ hasText: "A11y Tester" }).first().click();
  await expect(page.getByRole("heading", { name: "Support actions" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(r.violations.filter(v => v.impact === "serious" || v.impact === "critical").map(v => v.id)).toEqual([]);
});

test("keyboard: skip-to-content link and visible focus", async ({ page }) => {
  await page.goto("/docs");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("#content")).toBeFocused();
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe("none");
});

test("balance modal: focus inside, Escape closes, notices in an aria-live region", async ({ page }) => {
  await page.removeLocatorHandler(page.getByRole("dialog", { name: /balance/i }));
  await signupViaApi(page, "free");
  await page.goto("/dashboard");
  await expect(page.locator('[aria-live="polite"]').first()).toBeAttached();
  const left = (await (await page.request.get("/api/me")).json()).balance as number; // Free credits are prorated in the first month
  await page.request.post("/api/usage", { data: { requests: [{ requestId: `a11y-${Date.now()}`, inputTokens: Math.round(left * 500_000) }] } }); // uses up exactly the balance
  await page.reload();
  const dialog = page.getByRole("dialog", { name: /out of balance/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "API access is paused" })).toBeVisible();
});

test("390 px + axe: demo controls drawer and guided tour", async ({ page }) => {
  await signupViaApi(page, "pro");
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Demo controls" }).click();
  const drawer = page.getByRole("dialog", { name: "Demo controls" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Demo controls" })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  let r = await new AxeBuilder({ page }).include("#demo-drawer").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(r.violations.filter(v => v.impact === "serious" || v.impact === "critical").map(v => v.id)).toEqual([]);
  await drawer.getByRole("button", { name: "Start guided tour" }).click();
  const tour = page.getByTestId("tour");
  await expect(tour.getByRole("heading", { name: "Pricing" })).toBeFocused();
  await expect(tour).toBeInViewport();
  r = await new AxeBuilder({ page }).include("[data-testid=tour]").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(r.violations.filter(v => v.impact === "serious" || v.impact === "critical").map(v => v.id)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(tour).toBeHidden();
});
