// Seeds demo customers through the app's own API (mock mode) and refreshes the screenshots.
// Usage: node scripts/screens.mjs [baseUrl] [outDir]   (server must be running; ADMIN_PASSWORD or default)
import { chromium } from "@playwright/test";
const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? "/workspace/screens";
const ADMIN = process.env.ADMIN_PASSWORD ?? "nebula-admin";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = async (vp = { width: 1280, height: 900 }) => (await browser.newContext({ viewport: vp, baseURL: BASE, colorScheme: "dark" }));
const shot = async (page, name, full = true) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full }); console.log(`${OUT}/${name}.png`); };
const dismiss = async page => { const b = page.getByRole("button", { name: "Not now" }); if (await b.isVisible().catch(() => false)) await b.click(); };

// 1) Pro sample account (bundle + 30 days of history)
const pro = await ctx(); const p = await pro.newPage();
await p.goto("/"); await shot(p, "landing");
await p.goto("/api/demo"); await p.waitForURL(/dashboard/); await dismiss(p);
await p.request.post("/api/spend-cap", { data: { monthlyEur: 60 } });
await p.request.post("/api/promo", { data: { code: "WELCOME10" } });
await p.goto("/dashboard"); await dismiss(p); await shot(p, "dashboard");
await p.goto("/billing"); await dismiss(p); await shot(p, "billing");
await p.goto("/billing/invoices/draft-current"); await shot(p, "invoice-draft");
await p.goto("/keys"); await p.getByLabel("Name (so you can recognize it)").fill("production server");
await p.getByRole("button", { name: "Create key" }).click(); await p.getByTestId("api-key-secret").waitFor();
const secret = (await p.getByTestId("api-key-secret").textContent()).trim();
await p.request.post("/api/keys", { data: { name: "staging" } });
await shot(p, "api-keys");
for (let i = 0; i < 3; i++) await pro.request.post("/api/v1/completions", { headers: { Authorization: `Bearer ${secret}` }, data: { prompt: "Write a haiku about invoices ".repeat(20), max_tokens: 300 } });
await pro.request.post("/api/v1/images", { headers: { Authorization: `Bearer ${secret}` }, data: { prompt: "a lighthouse at dusk", n: 2 } });
await p.goto("/docs"); await shot(p, "docs");
await p.goto("/enterprise"); await shot(p, "enterprise");
const mob = await ctx({ width: 390, height: 844 }); await mob.addCookies(await pro.cookies());
const m = await mob.newPage(); await m.goto("/dashboard"); await dismiss(m); await shot(m, "dashboard-mobile");

// 2) Free customer that ran out of balance (blocked) → low-balance modal
const free = await ctx(); const f = await free.newPage();
await f.request.post("/api/signup", { data: { name: "Maya Chen", email: "maya@example.com", plan: "free" } });
await f.request.post("/api/usage", { data: { requests: [{ requestId: "seed-free-1", inputTokens: 400000, outputTokens: 200000 }, { requestId: "seed-free-2", images: 80 }] } });
await f.goto("/dashboard"); await f.getByRole("dialog").waitFor({ timeout: 8000 }).catch(() => {}); await shot(f, "low-balance-modal", false);

// 3) Scale customer with overage
const scale = await ctx(); const s = await scale.newPage();
await s.request.post("/api/signup", { data: { name: "Orbit Labs", email: "billing@orbitlabs.example", plan: "scale" } });
await s.request.post("/api/usage", { data: { requests: Array.from({ length: 12 }, (_, i) => ({ requestId: `seed-scale-${i}`, inputTokens: 9_000_000, outputTokens: 2_500_000, images: 150 })) } });
await s.goto("/dashboard"); await dismiss(s); await shot(s, "dashboard-scale");
await s.goto("/billing"); await dismiss(s); await shot(s, "billing-scale");

// 4) Support panel: list + customer detail with a goodwill credit
const adm = await ctx(); const a = await adm.newPage();
await a.goto("/admin"); await a.getByLabel("Support password").fill(ADMIN); await a.getByRole("button", { name: "Sign in" }).click();
await a.getByRole("link", { name: "Maya Chen" }).waitFor(); await shot(a, "admin");
await a.getByRole("link", { name: "Maya Chen" }).click(); await a.getByRole("heading", { name: "Support actions" }).waitFor();
await a.getByLabel("Amount (€)").fill("5"); await a.getByLabel("Reason").fill("API outage on 9/24");
await a.getByRole("button", { name: "Grant credit" }).click(); await a.getByRole("status").filter({ hasText: "granted" }).waitFor();
await shot(a, "admin-customer");
await browser.close();
