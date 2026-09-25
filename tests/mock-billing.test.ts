import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { balance, draftInvoice, lowBalanceLimit, mockBilling as b, upcomingInvoice, withInsights } from "@/lib/billing/mock";
import { enterpriseProposal, recommendPlan, usageLast30DaysFromDaily } from "@/lib/billing/insights";
import { _resetCache, getPurchase } from "@/lib/store";
import { handleMetronomeEvent } from "@/lib/webhooks";
import type { UsageRequest } from "@/lib/billing/types";
import { freshDataDir } from "./helpers";

// Imágenes: 0,04 € sin descuento; Pro 0,036 €; Scale 0,032 €.
let n = 0;
const img = (images: number, requestId = `r${++n}`): UsageRequest[] => [{ requestId, images }];
const at = (day: number, hour = 0) => vi.setSystemTime(new Date(Date.UTC(2026, 8, day, hour)));
const by = (a: { credits: { kind: string; remaining: number }[] }, k: string) => Math.round(a.credits.filter(c => c.kind === k).reduce((s, c) => s + c.remaining, 0) * 1e4) / 1e4;

beforeEach(() => {
  freshDataDir();
  process.env.MOCK_AUTO_PAYMENT_WEBHOOK = "1";
  vi.useFakeTimers();
  at(1); // 1 de septiembre (30 días): periodo completo
});
afterEach(() => vi.useRealTimers());

describe("signup", () => {
  it("at the start of the month charges the full fee and grants all credits", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    expect(balance(a)).toBe(30);
    expect(a.invoices[0]).toMatchObject({ amount: 29, status: "paid", type: "subscription" });
    const f = await b.signup({ name: "F", email: "f@x", plan: "free" });
    expect(f.invoices).toHaveLength(0);
    expect(balance(f)).toBe(5);
  });
  it("mid-month prorates fee AND credits (like Metronome's subscription + recurring credit)", async () => {
    at(16);
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    expect(balance(a)).toBe(15);
    expect(a.invoices[0].amount).toBe(14.5);
  });
  it("end-of-month sign-up: prorated credits can start below 20% and notify immediately (evaluate_on_create)", async () => {
    at(28);
    const f = await b.signup({ name: "F", email: "f@x", plan: "free" });
    expect(balance(f)).toBeLessThan(lowBalanceLimit(f));
    expect(f.alerts[0].type).toBe("low_balance");
  });
  it("Scale has the early threshold charge on by default", async () => {
    const a = await b.signup({ name: "S", email: "s@x", plan: "scale" });
    expect(a.spendThreshold).toEqual({ enabled: true, thresholdEur: 300, paymentGate: "STRIPE" });
  });
});

describe("plan change = contract transition", () => {
  it("mid-month upgrade Pro → Scale: charges the prorated difference, adds prorated new credits and keeps the balance", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    at(16);
    const r = await b.changePlan(a.customerId, "scale");
    expect(r.plan).toBe("scale");
    expect(r.invoices[0]).toMatchObject({ amount: 85, type: "proration" }); // (199 − 29) × 0,5
    expect(r.credits.find(c => c.label.includes("Scale credits (prorated)"))).toMatchObject({ kind: "recurring", amount: 125 }); // 250 × 0,5
    expect(balance(r)).toBe(155); // 30 arrastrados (rollover_fraction 1) + 125
  });
  it("downgrade Pro → Free: scheduled for the next period, keeps bundle and gift", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.buyBundle(a.customerId, "b50", "pur_down_1");
    await b.setAutoRecharge(a.customerId, true);
    at(20);
    let r = await b.changePlan(a.customerId, "free");
    expect(r.plan).toBe("pro"); // sigue en Pro hasta fin de mes
    expect(r.pendingPlan).toEqual({ plan: "free", effectiveAt: "2026-10-01T00:00:00.000Z" });
    const invoicesBefore = r.invoices.length;
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 1)));
    r = (await b.get(a.customerId))!;
    expect(r.plan).toBe("free");
    expect(r.pendingPlan).toBeUndefined();
    expect(by(r, "commit")).toBe(50); // bundle intacto
    expect(by(r, "gift")).toBe(5); // regalo intacto
    expect(by(r, "recurring")).toBe(5); // créditos Free del nuevo periodo (los de Pro caducan)
    expect(r.autoRecharge).toBe(false);
    expect(r.invoices.length).toBe(invoicesBefore); // Free no tiene cuota
  });
  it("picking the current plan again cancels the scheduled downgrade", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "scale" });
    await b.changePlan(a.customerId, "pro");
    const r = await b.changePlan(a.customerId, "scale");
    expect(r.pendingPlan).toBeUndefined();
  });
  it("re-syncs the 20% notice with the new plan (evaluate_on_create)", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    expect(lowBalanceLimit({ plan: "pro" })).toBe(6);
    at(30, 12); // queda ~1,7 % del mes → créditos Scale prorrateados ≈ 4,17 €
    const r = await b.changePlan(a.customerId, "scale");
    expect(balance(r)).toBeLessThan(lowBalanceLimit(r)); // < 50 €
    expect(r.alerts[0].type).toBe("low_balance");
  });
});

describe("period close", () => {
  it("invoices Scale overage, charges the new fee and renews plan credits", async () => {
    const a = await b.signup({ name: "S", email: "s@x", plan: "scale" });
    await b.ingest(a.customerId, img(10_000)); // 320 € → 70 € de exceso
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 2)));
    const r = (await b.get(a.customerId))!;
    const usage = r.invoices.find(i => i.type === "usage")!;
    expect(usage.amount).toBe(70);
    expect(r.invoices[0]).toMatchObject({ type: "subscription", amount: 199 });
    expect(r.overageAccrued).toBe(0);
    expect(balance(r)).toBe(250);
    expect(r.periodStart).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("burn-down order: plan → promo → gift → commit", () => {
  it("follows Metronome priorities (1, 3, 5, 10)", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.buyBundle(a.customerId, "b50", "pur_order_1"); // 50 € commit + 5 € regalo
    await b.redeemPromo(a.customerId, "WELCOME10"); // 10 € promo
    let r = (await b.ingest(a.customerId, img(1250))).account; // 45 €
    expect(by(r, "recurring")).toBe(0);
    expect(by(r, "promo")).toBe(0);
    expect(by(r, "gift")).toBe(0); // 45 = 30 (plan) + 10 (promo) + 5 (regalo)
    expect(by(r, "commit")).toBe(50); // el saldo pagado sigue intacto
    r = (await b.ingest(a.customerId, img(200))).account; // 7,2 €
    expect(by(r, "commit")).toBeCloseTo(42.8, 4);
  });
});

describe("blocking at 0 (Free and Pro)", () => {
  it("free: a request that uses exactly the balance is accepted, then the account is blocked", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "free" });
    const r = await b.ingest(a.customerId, img(125)); // 125 × €0.04 = €5
    expect(r.rejected).toBe(false);
    expect(balance(r.account)).toBe(0);
    expect(r.account.blocked).toBe(true);
    expect(r.account.overageAccrued).toBe(0);
    expect(r.account.alerts[0].type).toBe("zero_balance");
    const again = await b.ingest(a.customerId, img(1));
    expect(again.rejected).toBe(true);
    expect(again.reason).toBe("blocked");
  });
  it.each(["free", "pro"] as const)("%s: a request the balance can't cover is rejected up front (never below €0, no overage)", async plan => {
    const a = await b.signup({ name: "A", email: "a@x", plan });
    const before = balance(a);
    const r = await b.ingest(a.customerId, img(5000));
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe("insufficient_balance");
    expect(balance(r.account)).toBe(before);
    expect(r.account.overageAccrued).toBe(0);
    expect(r.account.usage).toHaveLength(0);
  });
  it("pro: fills the balance down to what's left, then rejects the next request; balance stays ≥ €0", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    expect((await b.ingest(a.customerId, img(833))).rejected).toBe(false); // 833 × €0.036 = €29.988
    const r = await b.ingest(a.customerId, img(1));
    expect(r.reason).toBe("insufficient_balance");
    expect(balance(r.account)).toBeGreaterThanOrEqual(0);
    expect(r.account.overageAccrued).toBe(0);
  });
  it("buying a bundle unblocks the account", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "free" });
    await b.ingest(a.customerId, img(125));
    const r = await b.buyBundle(a.customerId, "b50", "pur_unblock");
    expect(r.blocked).toBe(false);
    expect(balance(r)).toBe(55);
  });
});

describe("bundles: gift only after the payment webhook, matched by purchase id", () => {
  beforeEach(() => { process.env.MOCK_AUTO_PAYMENT_WEBHOOK = "0"; });
  const paid = (cid: string, id: string, status: "paid" | "failed" = "paid") =>
    handleMetronomeEvent({ id, type: "payment_gate.payment_status", properties: { customer_id: cid, contract_id: cid, workflow_type: "manual_commit", payment_status: status } }, { verified: true });

  it("no webhook, no gift; with payment_status=paid it is granted exactly once", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    let r = await b.buyBundle(a.customerId, "b200", "pur_gift_1");
    expect(by(r, "commit")).toBe(200);
    expect(by(r, "gift")).toBe(0);
    expect(getPurchase("pur_gift_1")?.status).toBe("payment_pending");
    await paid(a.customerId, "evt-pay-1");
    await paid(a.customerId, "evt-pay-2"); // otro pago posterior no vuelve a regalar
    r = (await b.get(a.customerId))!;
    expect(by(r, "gift")).toBe(30);
    expect(r.credits.find(c => c.kind === "gift")?.reference).toBe("pur_gift_1");
    expect(getPurchase("pur_gift_1")?.status).toBe("bonus_granted");
  });
  it("if payment fails: no commit, no gift, and the purchase is marked failed", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.buyBundle(a.customerId, "b50", "pur_fail_1");
    await paid(a.customerId, "evt-fail-1", "failed");
    const r = (await b.get(a.customerId))!;
    expect(by(r, "commit")).toBe(0);
    expect(by(r, "gift")).toBe(0);
    expect(r.invoices.find(i => i.externalId === "purchase:pur_fail_1")?.status).toBe("void");
    expect(getPurchase("pur_fail_1")?.status).toBe("failed");
  });
  it("repeating the purchase with the same id does not charge twice", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.buyBundle(a.customerId, "b50", "pur_same");
    const r = await b.buyBundle(a.customerId, "b50", "pur_same");
    expect(r.invoices.filter(i => i.type === "commit")).toHaveLength(1);
    expect(by(r, "commit")).toBe(50);
  });
});

describe("idempotent ingest by request id", () => {
  it("a retry with the same requestId is not charged again", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.ingest(a.customerId, img(100, "req-1"));
    const r = await b.ingest(a.customerId, [...img(100, "req-1"), ...img(100, "req-2")]);
    expect(r.duplicates).toBe(1);
    expect(balance(r.account)).toBeCloseTo(30 - 7.2, 4);
    expect(new Set(r.account.usage.map(u => u.requestId))).toEqual(new Set(["req-1", "req-2"]));
  });
});

describe("Scale: overage and early threshold charge", () => {
  it("does not block, accrues overage and charges €300 upfront at the threshold", async () => {
    const a = await b.signup({ name: "S", email: "s@x", plan: "scale" });
    let r = await b.ingest(a.customerId, img(10_000)); // 320 € − 250 € = 70 €
    expect(r.rejected).toBe(false);
    expect(r.account.overageAccrued).toBe(70);
    expect(r.account.invoices.some(i => i.type === "threshold")).toBe(false);
    r = await b.ingest(a.customerId, img(10_000)); // +320 € → 390 €
    expect(r.account.invoices[0]).toMatchObject({ type: "threshold", amount: 300 });
    expect(r.account.spendPrepaid).toBe(300);
    expect(draftInvoice(r.account).amount).toBe(90); // 390 − 300 ya cobrados
    expect(r.account.alerts.some(x => x.type === "payment" && x.message.includes("charged it early"))).toBe(true);
  });
  it("auto-recharge and threshold charge are mutually exclusive", async () => {
    const a = await b.signup({ name: "S", email: "s@x", plan: "scale" });
    await expect(b.setAutoRecharge(a.customerId, true)).rejects.toThrow(/threshold/);
    await b.setSpendThreshold(a.customerId, false);
    const r = await b.setAutoRecharge(a.customerId, true);
    expect(r.autoRecharge).toBe(true);
    await expect(b.setSpendThreshold(a.customerId, true)).rejects.toThrow(/auto-recharge/);
  });
  it("Scale only", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await expect(b.setSpendThreshold(a.customerId, true)).rejects.toThrow(/Scale/);
  });
});

describe("auto-recharge (top up to €50)", () => {
  it("below €10 it charges just enough to get back to €50", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.setAutoRecharge(a.customerId, true);
    const r = (await b.ingest(a.customerId, img(600))).account; // 21,6 € → quedan 8,4 €
    expect(balance(r)).toBeCloseTo(50, 4);
    expect(r.invoices[0]).toMatchObject({ amount: 41.6, type: "commit" });
    expect(r.alerts[0].type).toBe("auto_recharge");
  });
  it("not available on Free", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "free" });
    await expect(b.setAutoRecharge(a.customerId, true)).rejects.toThrow(/Pro and Scale/);
  });
});

describe("promo codes", () => {
  it("WELCOME10: €10 that expire after 30 days; once per customer", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "free" });
    const r = await b.redeemPromo(a.customerId, " welcome10 ");
    const promo = r.credits.find(c => c.kind === "promo")!;
    expect(promo).toMatchObject({ amount: 10, remaining: 10, reference: "WELCOME10", expiresAt: "2026-10-01T00:00:00.000Z" });
    await expect(b.redeemPromo(a.customerId, "WELCOME10")).rejects.toThrow(/already redeemed/);
    await expect(b.redeemPromo(a.customerId, "NOPE")).rejects.toThrow(/Invalid promo code/);
  });
  it("promo balance expires", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    at(10);
    await b.redeemPromo(a.customerId, "WELCOME10"); // caduca el 10 de octubre
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 11)));
    const r = (await b.get(a.customerId))!;
    expect(by(r, "promo")).toBe(0);
  });
});

describe("alerts", () => {
  it("notifies once when crossing 20% of plan credits", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    let r = (await b.ingest(a.customerId, img(700))).account; // 25,2 € → quedan 4,8 € (< 6 €)
    expect(r.alerts[0].type).toBe("low_balance");
    r = (await b.ingest(a.customerId, img(10))).account;
    expect(r.alerts.filter(x => x.type === "low_balance")).toHaveLength(1);
  });
  it("the zero-balance webhook cuts off access on Free/Pro (even if the local balance is not 0) and a payment restores it", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await handleMetronomeEvent({ id: "z1", type: "alerts.low_remaining_contract_credit_and_commit_balance_reached", properties: { customer_id: a.customerId, threshold: 0, remaining_balance: 0 } }, { verified: true });
    let r = (await b.get(a.customerId))!;
    expect(r.blocked).toBe(true);
    expect((await b.ingest(a.customerId, img(1))).rejected).toBe(true);
    await handleMetronomeEvent({ id: "p1", type: "payment_gate.payment_status", properties: { customer_id: a.customerId, contract_id: a.customerId, workflow_type: "manual_commit", payment_status: "paid" } }, { verified: true });
    r = (await b.get(a.customerId))!;
    expect(r.blocked).toBe(false);
  });
  it("…but not on Scale (overage)", async () => {
    const a = await b.signup({ name: "S", email: "s@x", plan: "scale" });
    await handleMetronomeEvent({ id: "z2", type: "alerts.low_remaining_contract_credit_and_commit_balance_reached", properties: { customer_id: a.customerId, threshold: 0, remaining_balance: 0 } }, { verified: true });
    expect((await b.get(a.customerId))!.blocked).toBe(false);
  });
});

describe("next invoice, 30-day usage and recommender", () => {
  it("the next invoice adds overage and next month's fee (or the scheduled plan's)", async () => {
    const a = await b.signup({ name: "S", email: "s@x", plan: "scale" });
    const r = (await b.ingest(a.customerId, img(10_000))).account;
    const u = upcomingInvoice(r);
    expect(u.totalDueEur).toBe(70 + 199);
    expect(u.creditsAppliedEur).toBe(250);
    expect(u.lines.map(l => l.type)).toEqual(["usage", "applied_commit_or_credit", "subscription"]);
    const down = await b.changePlan(a.customerId, "pro");
    expect(upcomingInvoice(down).lines.at(-1)).toMatchObject({ type: "subscription", totalEur: 29 });
  });
  it("30-day usage shaped as UsageLast30Days and recommended plan", async () => {
    at(25);
    const a = await b.signup({ name: "A", email: "a@x", plan: "free" });
    await b.buyBundle(a.customerId, "b200", "pur_u30");
    await b.ingest(a.customerId, img(100));
    const v = withInsights((await b.get(a.customerId))!);
    expect(v.usage30!.metrics.images.total).toBe(100);
    expect(v.usage30!.metrics.images.daily).toHaveLength(30);
    expect(v.usage30!.totalListCostEur).toBe(4);
  });
  it("recommendPlan: fee + (discounted) extra above credits; on Free/Pro the extra is paid with bundles", () => {
    // 100 € a precio de lista el primer día de la ventana (30 días de datos, sin proyección)
    const u = usageLast30DaysFromDaily("c", [{ day: "2026-08-27", metric: "images", quantity: 2500, cost: 0 }], new Date(Date.UTC(2026, 8, 25)));
    const r = recommendPlan(u, "free");
    expect(r.observedDays).toBe(30);
    expect(r.projected).toBe(false);
    expect(r.estimates.map(e => e.extraEur)).toEqual([95, 60, 0]); // setup: max(0, uso con dto − créditos)
    expect(r.estimates.map(e => e.totalMonthlyEur)).toEqual([82.61, 81.17, 199]); // b200: 200 € por 230 € de saldo
    expect(r.recommended).toBe("pro");
    expect(r.savingsVsCurrentEur).toBe(1.44);
  });
  it("Enterprise proposal shaped as EnterpriseContractSummary", () => {
    const p = enterpriseProposal({ customerId: "lead_1", commitAmountEur: 24_000 }, new Date(Date.UTC(2026, 8, 25, 10, 30)));
    expect(p).toMatchObject({ commitType: "POSTPAID", commitAmountEur: 24_000, monthlyEquivalentEur: 2000, startingAt: "2026-09-25T10:00:00.000Z", endingBefore: "2027-09-25T10:00:00.000Z" });
    expect(p.savingsVsListPct).toBe(22); // (20 % + 20 % + 25 %) / 3
  });
});

describe("persistence", () => {
  it("stores accounts in data/db.json and they survive a restart", async () => {
    const a = await b.signup({ name: "Persistente", email: "p@x", plan: "pro" });
    await b.ingest(a.customerId, img(10));
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, "db.json"))).toBe(true);
    _resetCache();
    const again = await b.get(a.customerId);
    expect(again?.name).toBe("Persistente");
    expect(balance(again!)).toBeCloseTo(29.64, 4);
    expect(again?.daily?.[0]).toMatchObject({ metric: "images", quantity: 10 });
  });
});
