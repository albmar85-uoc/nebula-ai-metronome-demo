import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_PASSWORD, autoDismissLowBalance, me, unique } from "./helpers";

// Full journey in mock mode, in order: Free sign-up → usage until blocked → upgrade to Pro → bundle →
// promo code → API key + curl-like request → spend limit (402) → goodwill credit from support.
test.describe.configure({ mode: "serial" });

let page: Page;
let api: APIRequestContext; // HTTP client without cookies, like curl
let apiKey = "";
const email = `${unique("lucy")}@example.com`;

test.beforeAll(async ({ browser, playwright, baseURL }) => {
  page = await (await browser.newContext()).newPage();
  await autoDismissLowBalance(page);
  api = await playwright.request.newContext({ baseURL });
});
test.afterAll(async () => { await page.context().close(); await api.dispose(); });

test("sign-up on the Free plan", async () => {
  await page.goto("/signup?plan=free");
  await page.getByLabel("Name").fill("Lucy E2E");
  await page.getByLabel("Email").fill(email);
  await expect(page.getByLabel("Plan")).toHaveValue("free");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: "Hi, Lucy E2E" })).toBeVisible();
  expect((await me(page)).plan).toBe("free");
});

test("simulated usage until the balance runs out: access paused and 402", async () => {
  await page.getByLabel(/Intensity/).fill("20");
  const blocked = page.getByText("Your balance is zero and API access is paused");
  for (let i = 0; i < 40 && !(await blocked.isVisible()); i++) {
    await page.getByRole("button", { name: "Send 1 request" }).click();
    await page.waitForTimeout(150);
  }
  await expect(blocked).toBeVisible();
  expect((await me(page)).blocked).toBe(true);
  await page.getByRole("button", { name: "Send 1 request" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Request rejected (402): balance used up" })).toBeVisible();
});

test("upgrade to Pro: immediate change and access re-enabled", async () => {
  await page.goto("/billing");
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  await expect.poll(async () => (await me(page)).plan).toBe("pro");
  expect((await me(page)).blocked).toBe(false);
  await expect(page.getByText("Your balance is zero and API access is paused")).toHaveCount(0);
});

test("bundle purchase: +€55 (€50 paid + €5 gift after the payment webhook)", async () => {
  const before = (await me(page)).balance;
  await page.getByRole("button", { name: "Pay €50.00 and get €55.00 balance" }).click();
  await expect.poll(async () => Math.round(((await me(page)).balance - before) * 100) / 100).toBe(55);
  await expect(page.getByRole("link", { name: "Bundle purchase: €50.00" })).toBeVisible();
});

test("promo code WELCOME10 (once per customer)", async () => {
  const before = (await me(page)).balance;
  await page.getByLabel("Promo code").fill("welcome10");
  await page.getByRole("button", { name: "Redeem" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Code WELCOME10 redeemed." })).toBeVisible();
  expect(Math.round(((await me(page)).balance - before) * 100) / 100).toBe(10);
  await page.getByLabel("Promo code").fill("WELCOME10");
  await page.getByRole("button", { name: "Redeem" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "You have already redeemed the code WELCOME10" })).toBeVisible();
});

test("API key: created, used like curl (cookie-less fetch) and the usage shows up on the dashboard", async () => {
  await page.goto("/keys");
  await page.getByLabel("Name (so you can recognize it)").fill("e2e server");
  await page.getByRole("button", { name: "Create key" }).click();
  apiKey = (await page.getByTestId("api-key-secret").textContent())!.trim();
  expect(apiKey).toMatch(/^nbl_test_/);
  await expect(page.getByRole("cell", { name: "e2e server", exact: true })).toBeVisible();

  expect((await api.post("/api/v1/completions", { data: { prompt: "hello" } })).status()).toBe(401);
  expect((await api.post("/api/v1/completions", { headers: { Authorization: "Bearer nbl_test_made-up-key-000000000000000" }, data: { prompt: "hello" } })).status()).toBe(401);

  const before = await me(page);
  const res = await api.post("/api/v1/completions", { headers: { Authorization: `Bearer ${apiKey}`, "Idempotency-Key": "e2e-order-1" }, data: { prompt: "a".repeat(4000), max_tokens: 500 } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ id: "idem_e2e-order-1", object: "text_completion", usage: { input_tokens: 1000, output_tokens: 500 } });
  expect(body.billing.cost_eur).toBeCloseTo(0.0054, 6); // Pro: 10% discount
  const replay = await api.post("/api/v1/completions", { headers: { Authorization: `Bearer ${apiKey}`, "Idempotency-Key": "e2e-order-1" }, data: { prompt: "a".repeat(4000), max_tokens: 500 } });
  expect(replay.headers()["idempotent-replayed"]).toBe("true");
  const img = await api.post("/api/v1/images", { headers: { Authorization: `Bearer ${apiKey}` }, data: { prompt: "a lighthouse", n: 3 } });
  expect(img.status()).toBe(200);
  expect((await img.json()).data).toHaveLength(3);
  const after = await me(page);
  expect(Math.round((before.balance - after.balance) * 10000) / 10000).toBeCloseTo(0.0054 + 0.108, 4);

  await page.goto("/dashboard");
  const rows = page.getByTestId("request-row");
  await expect(rows.filter({ hasText: "idem_e2e-order-1" })).toContainText("API");
  await expect(rows.filter({ hasText: "idem_e2e-order-1" })).toContainText("1,000 tokens in · 500 tokens out");
  await expect(rows.first()).toContainText("3 images");
});

test("monthly spend limit: notice and 402 spend_limit_reached", async () => {
  const spent = (await me(page)).spent;
  const cap = Math.max(1, Math.ceil((spent + 0.02) * 100) / 100);
  await page.goto("/billing");
  await page.getByLabel("Limit (€ per month)").fill(String(cap));
  await page.getByRole("button", { name: "Set limit" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Limit saved" })).toBeVisible();
  let status = 200, type = "";
  for (let i = 0; i < 60 && status === 200; i++) {
    const r = await api.post("/api/v1/completions", { headers: { Authorization: `Bearer ${apiKey}` }, data: { prompt: "spend", max_tokens: 4096 } });
    status = r.status();
    if (status !== 200) type = (await r.json()).error.type;
  }
  expect(status).toBe(402);
  expect(type).toBe("spend_limit_reached");
  await page.goto("/dashboard");
  await expect(page.getByText(/You've reached your monthly spend limit/).first()).toBeVisible();
  // Removing the limit allows requests again
  await page.goto("/billing");
  await page.getByRole("button", { name: "Remove limit" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Limit removed." })).toBeVisible();
  expect((await api.post("/api/v1/images", { headers: { Authorization: `Bearer ${apiKey}` }, data: { prompt: "x" } })).status()).toBe(200);
});

test("revoking the key: it stops authenticating", async () => {
  await page.goto("/keys");
  page.once("dialog", d => d.accept());
  await page.getByRole("button", { name: "Revoke key e2e server" }).click();
  await expect(page.getByText("revoked", { exact: true })).toBeVisible();
  expect((await api.post("/api/v1/images", { headers: { Authorization: `Bearer ${apiKey}` }, data: { prompt: "x" } })).status()).toBe(401);
});

test("support: login, customer search and goodwill credit", async ({ browser }) => {
  expect((await api.get("/api/admin/customers")).status()).toBe(401);
  const admin = await (await browser.newContext()).newPage();
  await admin.goto("/admin");
  await admin.getByLabel("Support password").fill("wrong");
  await admin.getByRole("button", { name: "Sign in" }).click();
  await expect(admin.getByRole("alert").filter({ hasText: "Wrong password" })).toBeVisible();
  await admin.getByLabel("Support password").fill(ADMIN_PASSWORD);
  await admin.getByRole("button", { name: "Sign in" }).click();
  await admin.getByRole("searchbox", { name: /Search customers/ }).fill(email);
  await admin.getByRole("button", { name: "Search" }).click();
  const row = admin.getByRole("row").filter({ hasText: email });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Pro");
  await row.getByRole("link", { name: "Lucy E2E" }).click();
  await expect(admin.getByRole("heading", { name: "Lucy E2E" })).toBeVisible();
  await expect(admin.getByRole("table", { name: "Plan history" })).toContainText("Upgrade (immediate): Free → Pro");

  const before = (await me(page)).balance;
  await admin.getByLabel("Amount (€)").fill("7");
  await admin.getByLabel("Reason").fill("e2e incident");
  await admin.getByRole("button", { name: "Grant credit" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "Goodwill credit of €7.00 granted." })).toBeVisible();
  await expect(admin.getByRole("table", { name: "Credits and commits" })).toContainText("Goodwill credit (support): e2e incident");
  await expect(admin.getByText(/Goodwill credit: €7\.00/)).toBeVisible();
  expect(Math.round(((await me(page)).balance - before) * 100) / 100).toBe(7);

  await page.goto("/dashboard");
  await expect(page.getByText(/Our support team added €7\.00/)).toBeVisible();
  await admin.context().close();
});
