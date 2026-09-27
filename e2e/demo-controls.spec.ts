import { expect, test, type Page } from "@playwright/test";
import { autoDismissLowBalance, me } from "./helpers";

// Presenter tooling (mock mode): Demo controls drawer, personas, traffic spike, fast-forward, toasts and the guided tour.
// Runs last (single worker, alphabetical): it resets all demo data and moves the demo clock, and resets again at the end.
test.describe.configure({ mode: "serial" });

let page: Page;
const toastWith = (text: string | RegExp) => page.getByTestId("toast").filter({ hasText: text });
const drawer = () => page.getByTestId("demo-drawer");
async function openDrawer() {
  if (!(await drawer().isVisible())) await page.getByRole("button", { name: "Demo controls" }).click();
  await expect(drawer()).toBeVisible();
}
async function persona(title: RegExp) {
  await openDrawer();
  await drawer().getByRole("button", { name: title }).click();
  await expect(drawer()).toBeHidden(); // the page reloads signed in as the persona
  await page.waitForLoadState("load");
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await autoDismissLowBalance(page);
});
test.afterAll(async () => {
  await page.request.post("/api/demo/controls", { data: { action: "reset" } });
  await page.context().close();
});

test("Shift+D opens the drawer; reset seeds the four personas and signs in", async () => {
  await page.goto("/");
  await page.locator("body").press("Shift+D");
  await expect(drawer()).toBeVisible();
  await drawer().getByRole("button", { name: "Reset demo data" }).click();
  await drawer().getByRole("button", { name: "Confirm: erase everything" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(toastWith("Demo data reset.")).toBeVisible();
  await openDrawer();
  await expect(drawer().getByRole("group", { name: "Personas" }).getByRole("button")).toHaveCount(4);
  await expect(drawer().getByRole("button", { name: /Pro startup with auto-recharge/ })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(drawer()).toBeHidden();
});

test("persona: Free hobbyist near the limit", async () => {
  await persona(/Free hobbyist near the limit/);
  await expect(page.getByRole("heading", { name: "Hi, Hana Sato" })).toBeVisible();
  await expect(toastWith("Now signed in as Hana Sato")).toBeVisible();
  const a = await me(page);
  expect(a.plan).toBe("free");
  expect(a.balance).toBeGreaterThan(0);
  expect(a.balance).toBeLessThan(1);
});

test("traffic spike on Scale triggers the early usage charge (spend threshold)", async () => {
  await persona(/Scale company with overage/);
  await expect(page.getByRole("heading", { name: "Hi, Priya Nair" })).toBeVisible();
  await openDrawer();
  await drawer().getByRole("button", { name: "Traffic spike" }).click();
  await expect(toastWith(/early charge of €300\.00 \(spend threshold\)/)).toBeVisible();
  await expect(toastWith(/Usage spike: your overage reached €300\.00/)).toBeVisible(); // the alert itself, as a toast
  await page.goto("/billing");
  await expect(page.getByRole("link", { name: /Early charge: overage reached €300\.00/ })).toBeVisible();
  // Scale: the €300 threshold charge is always on (no turn-off), and auto-recharge can be turned on alongside it.
  await expect(page.getByTestId("st-always-badge")).toHaveText("Always on");
  await expect(page.getByRole("button", { name: "Turn off early threshold charge" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Turn on auto-recharge" })).toBeEnabled();
  const off = await page.request.post("/api/spend-threshold", { data: { enabled: false } });
  expect(off.status()).toBe(400);
  expect((await off.json()).error).toBe("The early threshold charge is always on for the Scale plan");
});

test("fast-forward to month end runs the month close", async () => {
  const before = await me(page) as unknown as { periodEnd: string; overageAccrued: number };
  await openDrawer();
  await drawer().getByRole("button", { name: "Fast-forward to month end" }).click();
  await expect(toastWith(/Month closed \(.+\): overage invoice €/)).toBeVisible();
  await expect(drawer().getByTestId("demo-clock")).toContainText("days ahead");
  const after = await me(page) as unknown as { periodStart: string; overageAccrued: number; balance: number };
  expect(after.periodStart).toBe(before.periodEnd);
  expect(after.overageAccrued).toBe(0);
  expect(after.balance).toBe(250);
  await page.goto("/billing");
  await expect(page.getByRole("link", { name: /^Overage for / }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Scale monthly fee/ }).first()).toBeVisible();
});

test("Free month close: the €0 usage invoice is labelled \"Not sent to Stripe\" (billable_status unbillable)", async () => {
  await page.goto("/dashboard");
  await persona(/Free hobbyist near the limit/);
  await openDrawer();
  await drawer().getByRole("button", { name: "Fast-forward to month end" }).click();
  await expect(drawer().getByTestId("demo-clock")).toContainText("days ahead");
  await page.goto("/billing");
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: /^Free usage for / }) }).first();
  await expect(row).toContainText("€0.00");
  const badge = row.getByTestId("unbillable");
  await expect(badge).toContainText("Not sent to Stripe");
  await expect(badge).toHaveAttribute("title", /isn't sent to Stripe and there's nothing to pay/);
  await expect(row.getByText("paid", { exact: true })).toHaveCount(0); // replaces the misleading "paid" badge
  await row.getByRole("link", { name: /^Free usage for / }).click();
  await expect(page.getByText("Metronome marked this invoice as unbillable").first()).toBeVisible();
});

test("traffic spike on Pro triggers auto-recharge (12-month top-ups); Free cannot enable it; Enterprise persona opens the proposal page", async () => {
  await persona(/Pro startup with auto-recharge/);
  await openDrawer();
  await drawer().getByRole("button", { name: "Traffic spike" }).click();
  await expect(toastWith(/auto-recharge charged €/)).toBeVisible();
  // Top-ups: 12 months and carried over in full on plan change (same commit terms as the live adapter).
  await page.goto("/billing");
  await expect(page.getByTestId("ar-terms")).toHaveText("Each top-up is valid for 12 months and carries over in full when you change plans.");
  await expect(page.getByRole("button", { name: "Turn off auto-recharge" })).toBeEnabled();
  // Never on Free: toggle disabled and the API refuses (403).
  await persona(/Free hobbyist near the limit/);
  await page.goto("/billing");
  await expect(page.getByRole("button", { name: "Turn on auto-recharge" })).toBeDisabled();
  const r = await page.request.post("/api/autorecharge", { data: { enabled: true } });
  expect(r.status()).toBe(403);
  expect((await r.json()).error).toBe("Auto-recharge is only available on Pro and Scale");
  await persona(/Enterprise prospect/);
  await expect(page).toHaveURL(/\/enterprise/);
});

test("toasts can be dismissed and never block clicks", async () => {
  await page.goto("/dashboard");
  await openDrawer();
  await drawer().getByRole("button", { name: "Traffic spike" }).click();
  const t = page.getByTestId("toast").first();
  await expect(t).toBeVisible();
  expect(await t.evaluate(el => getComputedStyle(el).pointerEvents)).toBe("none");
  await page.getByRole("button", { name: /^Dismiss notification/ }).first().click();
  await page.keyboard.press("Escape");
});

test("guided tour walks through the 10 steps across pages", async () => {
  await persona(/Pro startup with auto-recharge/);
  await openDrawer();
  await drawer().getByRole("button", { name: "Start guided tour" }).click();
  const tour = page.getByTestId("tour");
  const steps: [string, RegExp][] = [
    ["Pricing", /\/$/], ["Sign-up", /\/signup$/], ["Usage", /\/dashboard$/], ["Alerts", /\/dashboard$/], ["Upgrade", /\/billing$/],
    ["Bundles", /\/billing$/], ["Promo codes", /\/billing$/], ["Next invoice", /\/dashboard$/], ["API keys", /\/keys$/], ["Support panel", /\/admin$/],
  ];
  for (const [i, [title, url]] of steps.entries()) {
    await expect(tour.getByRole("heading", { name: title })).toBeVisible();
    await expect(tour).toContainText(`step ${i + 1} of 10`);
    await expect(tour).toContainText("Metronome:");
    await expect(page).toHaveURL(url);
    await tour.getByRole("button", { name: i === steps.length - 1 ? "Finish" : "Next" }).click();
  }
  await expect(tour).toBeHidden();
  // ?tour=1 starts it; Escape ends it
  await page.goto("/?tour=1");
  await expect(tour.getByRole("heading", { name: "Pricing" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tour).toBeHidden();
});
