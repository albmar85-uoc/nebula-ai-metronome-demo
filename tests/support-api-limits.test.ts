import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { balance, mockBilling as b, setAccessCutMock } from "@/lib/billing/mock";
import { bestBundleFor, recommendPlan, usageLast30DaysFromDaily } from "@/lib/billing/insights";
import { capAlerts, fitsCap, normalizeCap, periodSpend, requestCost } from "@/lib/billing/limits";
import { authenticate, createApiKey, hashKey, MAX_ACTIVE_KEYS, revokeApiKey } from "@/lib/apikeys";
import { estimateTokens, handlePublicCall, parseCompletion, parseImages } from "@/lib/publicApi";
import { adminToken, checkPassword, DEFAULT_ADMIN_PASSWORD } from "@/lib/admin";
import { getPlanHistory, listApiKeys } from "@/lib/store";
import type { UsageRequest } from "@/lib/billing/types";
import { freshDataDir } from "./helpers";

let n = 0;
const img = (images: number, requestId = `r3_${++n}`): UsageRequest[] => [{ requestId, images }];
const at = (month: number, day: number, hour = 0) => vi.setSystemTime(new Date(Date.UTC(2026, month - 1, day, hour)));
const NOW = new Date(Date.UTC(2026, 8, 25));

beforeEach(() => {
  freshDataDir();
  process.env.MOCK_AUTO_PAYMENT_WEBHOOK = "1";
  delete process.env.API_KEY_PEPPER;
  delete process.env.ADMIN_PASSWORD;
  vi.useFakeTimers({ toFake: ["Date"] });
  at(9, 1);
});
afterEach(() => vi.useRealTimers());

describe("plan recommender", () => {
  it("projects to 30 days when there is little data (minimum 7 days)", () => {
    const u = usageLast30DaysFromDaily("c", [{ day: "2026-09-20", metric: "images", quantity: 2500, cost: 0 }], NOW); // 6 días de datos
    const r = recommendPlan(u, "pro");
    expect(r.observedDays).toBe(6);
    expect(r.projected).toBe(true);
    expect(r.monthlyListCostEur).toBeCloseTo(428.57, 2); // 100 € × 30/7
    expect(r.recommended).toBe("scale"); // Scale: 342,86 € de uso con dto < 250 € + extra 92,86 → 291,86 € < 199 + …
    expect(r.estimates.find(e => e.plan === "scale")).toMatchObject({ coverage: "overage", extraPaidEur: 92.86, totalMonthlyEur: 291.86 });
  });
  it("with no usage it does not recommend a change and marks the current plan", () => {
    const r = recommendPlan(usageLast30DaysFromDaily("c", [], NOW), "pro");
    expect(r.observedDays).toBe(0);
    expect(r.recommended).toBe("pro");
    expect(r.savingsVsCurrentEur).toBe(0);
  });
  it("savings per plan vs. the current one and Enterprise hint on high spend", () => {
    const u = usageLast30DaysFromDaily("c", [{ day: "2026-08-27", metric: "images", quantity: 60_000, cost: 0 }], NOW); // 2.400 € de lista
    const r = recommendPlan(u, "scale");
    expect(r.enterpriseHint).toBe(true);
    const free = r.estimates.find(e => e.plan === "free")!;
    expect(free.coverage).toBe("bundles");
    expect(free.bundle).toBe("b1000");
    expect(free.savingsVsCurrentEur).toBeLessThan(0);
  });
  it("picks the cheapest bundle that gets used within its 12 months", () => {
    expect(bestBundleFor(3)).toBe("b50");
    expect(bestBundleFor(20)).toBe("b200"); // 230 € de saldo ≤ 240 € en 12 meses
    expect(bestBundleFor(100)).toBe("b1000");
  });
});

describe("monthly spend limit", () => {
  it("pure functions: upfront cost, fit, and notices once per period", () => {
    expect(requestCost({ requestId: "x", inputTokens: 1_000_000, outputTokens: 1_000_000, images: 10 }, 0.1)).toBeCloseTo(9.36, 6);
    expect(fitsCap(undefined, 1e6, 1)).toBe(true);
    expect(fitsCap({ monthlyEur: 10 }, 9, 1)).toBe(true);
    expect(fitsCap({ monthlyEur: 10 }, 9, 1.01)).toBe(false);
    const cap = { monthlyEur: 10 };
    expect(capAlerts(cap, 7.9, "p1")).toEqual([]);
    expect(capAlerts(cap, 8, "p1")).toEqual(["80"]);
    expect(capAlerts(cap, 9, "p1")).toEqual([]);
    expect(capAlerts(cap, 10, "p1")).toEqual(["100"]);
    expect(capAlerts(cap, 10, "p2")).toEqual(["80", "100"]);
    expect(() => normalizeCap(0.5, 0)).toThrow(/between/);
    expect(normalizeCap(null, 0)).toBeUndefined();
    expect(periodSpend([{ day: "2026-08-31", metric: "images", quantity: 1, cost: 5 }, { day: "2026-09-02", metric: "images", quantity: 1, cost: 2 }], "2026-09-01T00:00:00.000Z")).toBe(2);
  });
  it("notifies at 80%, rejects the request that would exceed it and resets on a new period", async () => {
    const a = await b.signup({ name: "Cap", email: "c@x", plan: "pro" }); // imágenes a 0,036 €
    await b.setSpendCap(a.customerId, 1);
    const r1 = await b.ingest(a.customerId, img(25)); // 0,90 € ≥ 80 %
    expect(r1.rejected).toBe(false);
    expect(r1.accepted).toHaveLength(1);
    expect(r1.account.alerts.filter(x => x.type === "spend_cap")).toHaveLength(1);
    const r2 = await b.ingest(a.customerId, img(25)); // 1,80 € > 1 € → 402
    expect(r2).toMatchObject({ rejected: true, reason: "spend_cap", accepted: [] });
    expect(r2.account.alerts.filter(x => x.type === "spend_cap")).toHaveLength(2);
    expect(balance(r2.account)).toBeCloseTo(29.1, 4); // no se cobró la petición rechazada
    const r3 = await b.ingest(a.customerId, img(2)); // 0,072 € sí cabe
    expect(r3.rejected).toBe(false);
    at(10, 2);
    const r4 = await b.ingest(a.customerId, img(25));
    expect(r4.rejected).toBe(false);
    await b.setSpendCap(a.customerId, null);
    expect((await b.get(a.customerId))!.spendCap).toBeUndefined();
  });
  it("a used-up balance is distinguished from the limit (reason blocked)", async () => {
    const a = await b.signup({ name: "F", email: "f@x", plan: "free" });
    await b.ingest(a.customerId, img(125)); // 5 €
    const r = await b.ingest(a.customerId, img(1));
    expect(r).toMatchObject({ rejected: true, reason: "blocked" });
  });
});

describe("support actions", () => {
  it("goodwill credit, idempotent by grantId, unblocks a Free account with no balance", async () => {
    const a = await b.signup({ name: "F", email: "f@x", plan: "free" });
    await b.ingest(a.customerId, img(125));
    expect((await b.get(a.customerId))!.blocked).toBe(true);
    const g = { grantId: "gw_test_1", amountEur: 5, reason: "incidencia", validDays: 90 };
    const r = await b.grantGoodwill(a.customerId, g);
    expect(r.blocked).toBe(false);
    expect(balance(r)).toBe(5);
    expect(r.credits.find(c => c.reference === "goodwill:gw_test_1")).toMatchObject({ kind: "promo", expiresAt: "2026-11-30T00:00:00.000Z" });
    expect(balance(await b.grantGoodwill(a.customerId, g))).toBe(5);
    expect(r.alerts[0].type).toBe("support");
    await expect(b.grantGoodwill(a.customerId, { ...g, grantId: "gw_x", amountEur: 0 })).rejects.toThrow();
  });
  it("unblock lifts the webhook cut-off but does not create balance", async () => {
    const a = await b.signup({ name: "P", email: "p@x", plan: "pro" });
    setAccessCutMock(a.customerId, true);
    expect((await b.get(a.customerId))!.blocked).toBe(true);
    expect((await b.unblock(a.customerId)).blocked).toBe(false);
  });
  it("plan history with who made each change (customer, support, system)", async () => {
    const a = await b.signup({ name: "H", email: "h@x", plan: "free" });
    await b.changePlan(a.customerId, "scale", "support");
    await b.changePlan(a.customerId, "pro");
    await b.changePlan(a.customerId, "scale"); // cancela la bajada
    await b.changePlan(a.customerId, "pro");
    at(10, 1, 1);
    await b.get(a.customerId);
    const h = getPlanHistory(a.customerId).map(e => `${e.kind}:${e.to}:${e.actor}`);
    expect(h).toEqual(["downgrade_applied:pro:system", "downgrade_scheduled:pro:customer", "downgrade_cancelled:pro:customer", "downgrade_scheduled:pro:customer", "upgrade:scale:support", "signup:free:customer"]);
  });
  it("support password: README default, configurable via env", () => {
    expect(checkPassword(DEFAULT_ADMIN_PASSWORD)).toBe(true);
    expect(checkPassword("otra")).toBe(false);
    const t1 = adminToken();
    process.env.ADMIN_PASSWORD = "s3creta";
    expect(checkPassword("s3creta")).toBe(true);
    expect(checkPassword(DEFAULT_ADMIN_PASSWORD)).toBe(false);
    expect(adminToken()).not.toBe(t1); // cambiarla invalida las sesiones
  });
});

describe("API keys", () => {
  const hdr = (k: string) => new Headers({ authorization: `Bearer ${k}` });
  it("shown once, only the hash is stored, and they can be revoked", async () => {
    const { secret, key } = createApiKey("cus_1", "servidor", "mock");
    expect(secret).toMatch(/^nbl_test_[A-Za-z0-9_-]{32}$/);
    expect(key).not.toHaveProperty("hash");
    expect(key.prefix).toBe(secret.slice(0, 14));
    const db = fs.readFileSync(path.join(process.env.DATA_DIR!, "db.json"), "utf8");
    expect(db).not.toContain(secret);
    expect(db).toContain(hashKey(secret));
    expect(authenticate(hdr(secret))?.customerKey).toBe("cus_1");
    expect(authenticate(new Headers({ "x-api-key": secret }))?.id).toBe(key.id);
    expect(authenticate(hdr(secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A")))).toBeNull();
    expect(authenticate(new Headers())).toBeNull();
    revokeApiKey("cus_1", key.id);
    expect(authenticate(hdr(secret))).toBeNull();
    expect(() => revokeApiKey("otro", key.id)).toThrow(/not found/);
  });
  it("validates name, max active keys and optional pepper", () => {
    expect(() => createApiKey("c", "  ", "mock")).toThrow(/name/);
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) createApiKey("c", `k${i}`, "mock");
    expect(() => createApiKey("c", "one more", "mock")).toThrow(/Maximum/);
    revokeApiKey("c", listApiKeys("c")[0].id);
    expect(createApiKey("c", "now it works", "metronome").secret).toMatch(/^nbl_live_/);
    const plain = hashKey("nbl_test_x");
    process.env.API_KEY_PEPPER = "pimienta";
    expect(hashKey("nbl_test_x")).not.toBe(plain);
  });
});

describe("public API /api/v1", () => {
  const call = (parse: typeof parseCompletion, body: unknown, key?: string, extra: Record<string, string> = {}) =>
    handlePublicCall(new Request("http://x/api/v1", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) }), parse);

  it("validates parameters and estimates tokens", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
    expect(parseCompletion({ prompt: "" })).toMatch(/prompt/);
    expect(parseCompletion({ prompt: "x", max_tokens: 5000 })).toMatch(/max_tokens/);
    expect(parseCompletion({ prompt: "x", model: "gpt" })).toMatch(/Model not available/);
    expect(parseImages({ prompt: "x", n: 11 })).toMatch(/"n"/);
    expect(parseImages({ prompt: "x", size: "2048x2048" })).toMatch(/size/);
    const ok = parseCompletion({ prompt: "a".repeat(4000), max_tokens: 500 });
    expect(typeof ok !== "string" && ok.usage).toMatchObject({ inputTokens: 1000, outputTokens: 500, model: "nebula-1" });
  });
  it("401 without a key, 400 on invalid JSON and 200 with usage recorded through the same billing path", async () => {
    const a = await b.signup({ name: "Api", email: "api@x", plan: "pro" });
    const { secret } = createApiKey(a.customerId, "test", "mock");
    expect((await call(parseCompletion, { prompt: "hola" })).status).toBe(401);
    expect((await call(parseCompletion, "{no json", secret)).status).toBe(400);
    const res = await call(parseCompletion, { prompt: "a".repeat(4000), max_tokens: 500 }, secret);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.billing.cost_eur).toBeCloseTo(0.0054, 6);
    expect(res.headers.get("x-request-id")).toBe(j.id);
    const acc = (await b.get(a.customerId))!;
    expect(acc.usage.filter(u => u.requestId === j.id).map(u => u.metric).sort()).toEqual(["input_tokens", "output_tokens"]);
    const im = await (await call(parseImages, { prompt: "faro", n: 2 }, secret)).json();
    expect(im.data).toHaveLength(2);
    expect(im.billing.cost_eur).toBeCloseTo(0.072, 6);
  });
  it("Idempotency-Key: a retry is not charged twice", async () => {
    const a = await b.signup({ name: "Idem", email: "i@x", plan: "pro" });
    const { secret } = createApiKey(a.customerId, "test", "mock");
    const r1 = await call(parseImages, { prompt: "x", n: 5 }, secret, { "idempotency-key": "pedido-1" });
    const r2 = await call(parseImages, { prompt: "x", n: 5 }, secret, { "idempotency-key": "pedido-1" });
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect((await r2.json()).billing.cost_eur).toBe(0);
    expect((await r1.json()).id).toBe("idem_pedido-1");
    expect(balance((await b.get(a.customerId))!)).toBeCloseTo(30 - 0.18, 4);
    expect((await call(parseImages, { prompt: "x" }, secret, { "idempotency-key": "con espacios" })).status).toBe(400);
  });
  it("402 insufficient_balance with no balance (Free) and 402 spend_limit_reached with a limit", async () => {
    const f = await b.signup({ name: "F", email: "f@x", plan: "free" });
    const kf = createApiKey(f.customerId, "f", "mock").secret;
    await b.ingest(f.customerId, img(125));
    const r = await call(parseImages, { prompt: "x" }, kf);
    expect(r.status).toBe(402);
    expect((await r.json()).error.type).toBe("insufficient_balance");
    const p = await b.signup({ name: "P", email: "p@x", plan: "pro" });
    const kp = createApiKey(p.customerId, "p", "mock").secret;
    await b.setSpendCap(p.customerId, 1);
    expect((await call(parseImages, { prompt: "x", n: 10 }, kp)).status).toBe(200); // 0,36 €
    expect((await call(parseImages, { prompt: "x", n: 10 }, kp)).status).toBe(200); // 0,72 €
    const capped = await call(parseImages, { prompt: "x", n: 10 }, kp); // 1,08 € > 1 €
    expect(capped.status).toBe(402);
    expect((await capped.json()).error).toMatchObject({ type: "spend_limit_reached", spend_cap_eur: 1 });
  });
});
