// Refreshes the screenshots using the demo controls (mock mode): resets demo data, then walks the personas.
// Usage: node scripts/screens.mjs [baseUrl] [outDir]   (server running on baseUrl; ADMIN_PASSWORD or default)
import { chromium } from "@playwright/test";
const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? "/workspace/screens";
const ADMIN = process.env.ADMIN_PASSWORD ?? "nebula-admin";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = (vp = { width: 1280, height: 900 }) => browser.newContext({ viewport: vp, baseURL: BASE, colorScheme: "dark", locale: "en-US" });
const HIDE = ".toasts{display:none!important}";
async function shot(page, name, { full = true, toasts = false } = {}) {
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(450);
  const tag = toasts ? null : await page.addStyleTag({ content: HIDE });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  if (tag) await tag.evaluate(el => el.remove());
  console.log(`${OUT}/${name}.png`);
}
const dismissModal = async page => { const b = page.getByRole("button", { name: "Not now" }); if (await b.isVisible().catch(() => false)) await b.click(); };
const control = (page, data) => page.request.post("/api/demo/controls", { data });
async function as(page, persona) { const r = await (await control(page, { action: "persona", persona })).json(); await page.goto(r.redirect); await dismissModal(page); }

const c = await ctx(); const p = await c.newPage();
await control(p, { action: "reset", persona: "pro" });
await p.goto("/"); await shot(p, "landing");

// Pro startup (auto-recharge)
await as(p, "pro");
await p.request.post("/api/promo", { data: { code: "WELCOME10" } });
await p.request.post("/api/spend-cap", { data: { monthlyEur: 150 } });
await p.goto("/dashboard"); await dismissModal(p); await shot(p, "dashboard");
await p.goto("/billing"); await dismissModal(p); await shot(p, "billing");
await p.goto("/billing/invoices/draft-current"); await shot(p, "invoice-draft");
await p.goto("/keys"); await p.getByLabel("Name (so you can recognize it)").fill("production server");
await p.getByRole("button", { name: "Create key" }).click(); await p.getByTestId("api-key-secret").waitFor();
const secret = (await p.getByTestId("api-key-secret").textContent()).trim();
await p.request.post("/api/keys", { data: { name: "staging" } });
await shot(p, "api-keys");
for (let i = 0; i < 3; i++) await c.request.post("/api/v1/completions", { headers: { Authorization: `Bearer ${secret}` }, data: { prompt: "Write a haiku about invoices ".repeat(20), max_tokens: 300 } });
await p.goto("/docs"); await shot(p, "docs");
const mob = await ctx({ width: 390, height: 844 }); await mob.addCookies(await c.cookies());
const m = await mob.newPage(); await m.goto("/dashboard"); await dismissModal(m); await shot(m, "dashboard-mobile");

// Guided tour (step 5: Upgrade on /billing)
await p.goto("/billing"); await dismissModal(p);
await p.evaluate(() => { localStorage.setItem("nebula-tour", "4"); window.dispatchEvent(new CustomEvent("nebula:tour")); });
await p.getByTestId("tour").waitFor(); await p.waitForTimeout(700);
await shot(p, "tour", { full: false });
await p.keyboard.press("Escape");

// Free hobbyist → runs out of balance → low-balance modal
await as(p, "free");
await control(p, { action: "spike" });
await p.goto("/dashboard"); await p.getByRole("dialog", { name: /balance/i }).waitFor({ timeout: 8000 }).catch(() => {});
await shot(p, "low-balance-modal", { full: false });

// Scale company: spike (early charge) + demo controls drawer with toasts
await as(p, "scale");
await shot(p, "dashboard-scale");
await p.getByRole("button", { name: "Demo controls" }).click();
await p.getByTestId("demo-drawer").getByRole("button", { name: "Traffic spike" }).click();
await p.getByTestId("toast").filter({ hasText: "early charge" }).waitFor();
await p.waitForTimeout(600);
await shot(p, "demo-controls", { full: false, toasts: true });
await p.keyboard.press("Escape");
await p.goto("/billing"); await dismissModal(p); await shot(p, "billing-scale");

// Enterprise prospect
await as(p, "enterprise"); await shot(p, "enterprise");

// Support panel
const adm = await ctx(); const a = await adm.newPage();
await a.goto("/admin"); await a.getByLabel("Support password").fill(ADMIN); await a.getByRole("button", { name: "Sign in" }).click();
await a.getByRole("link", { name: "Hana Sato" }).waitFor(); await shot(a, "admin");
await a.getByRole("link", { name: "Hana Sato" }).click(); await a.getByRole("heading", { name: "Support actions" }).waitFor();
await a.getByLabel("Amount (€)").fill("5"); await a.getByLabel("Reason").fill("API outage on 9/24");
await a.getByRole("button", { name: "Grant credit" }).click(); await a.getByRole("status").filter({ hasText: "granted" }).waitFor();
await shot(a, "admin-customer");

// Leave the demo ready to present: fresh data, signed out.
await control(p, { action: "reset", persona: "pro" });
await browser.close();
