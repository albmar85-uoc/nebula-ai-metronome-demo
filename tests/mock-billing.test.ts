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

describe("alta", () => {
  it("a principio de mes cobra la cuota completa y concede todos los créditos", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    expect(balance(a)).toBe(30);
    expect(a.invoices[0]).toMatchObject({ amount: 29, status: "paid", type: "subscription" });
    const f = await b.signup({ name: "F", email: "f@x", plan: "free" });
    expect(f.invoices).toHaveLength(0);
    expect(balance(f)).toBe(5);
  });
  it("a mitad de mes prorratea cuota Y créditos (como la suscripción + recurring credit de Metronome)", async () => {
    at(16);
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    expect(balance(a)).toBe(15);
    expect(a.invoices[0].amount).toBe(14.5);
  });
  it("alta a final de mes: los créditos prorrateados pueden nacer bajo el 20 % y avisan al momento (evaluate_on_create)", async () => {
    at(28);
    const f = await b.signup({ name: "F", email: "f@x", plan: "free" });
    expect(balance(f)).toBeLessThan(lowBalanceLimit(f));
    expect(f.alerts[0].type).toBe("low_balance");
  });
  it("Scale lleva el cobro anticipado por umbral activado por defecto", async () => {
    const a = await b.signup({ name: "S", email: "s@x", plan: "scale" });
    expect(a.spendThreshold).toEqual({ enabled: true, thresholdEur: 300, paymentGate: "STRIPE" });
  });
});

describe("cambio de plan = transición de contrato", () => {
  it("subida Pro → Scale a mitad de mes: cobra la diferencia prorrateada, añade los créditos nuevos prorrateados y conserva el saldo", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    at(16);
    const r = await b.changePlan(a.customerId, "scale");
    expect(r.plan).toBe("scale");
    expect(r.invoices[0]).toMatchObject({ amount: 85, type: "proration" }); // (199 − 29) × 0,5
    expect(r.credits.find(c => c.label.includes("Scale (prorrateados)"))).toMatchObject({ kind: "recurring", amount: 125 }); // 250 × 0,5
    expect(balance(r)).toBe(155); // 30 arrastrados (rollover_fraction 1) + 125
  });
  it("bajada Pro → Free: se programa al siguiente periodo y conserva bundle y regalo", async () => {
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
  it("volver a elegir el plan actual cancela la bajada programada", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "scale" });
    await b.changePlan(a.customerId, "pro");
    const r = await b.changePlan(a.customerId, "scale");
    expect(r.pendingPlan).toBeUndefined();
  });
  it("re-sincroniza el aviso del 20 % con el plan nuevo (evaluate_on_create)", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    expect(lowBalanceLimit({ plan: "pro" })).toBe(6);
    at(30, 12); // queda ~1,7 % del mes → créditos Scale prorrateados ≈ 4,17 €
    const r = await b.changePlan(a.customerId, "scale");
    expect(balance(r)).toBeLessThan(lowBalanceLimit(r)); // < 50 €
    expect(r.alerts[0].type).toBe("low_balance");
  });
});

describe("cierre de periodo", () => {
  it("factura el uso extra de Scale, cobra la cuota nueva y renueva los créditos del plan", async () => {
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

describe("orden de consumo: plan → promo → regalo → commit", () => {
  it("respeta las prioridades de Metronome (1, 3, 5, 10)", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.buyBundle(a.customerId, "b50", "pur_order_1"); // 50 € commit + 5 € regalo
    await b.redeemPromo(a.customerId, "BIENVENIDA10"); // 10 € promo
    let r = (await b.ingest(a.customerId, img(1250))).account; // 45 €
    expect(by(r, "recurring")).toBe(0);
    expect(by(r, "promo")).toBe(0);
    expect(by(r, "gift")).toBe(0); // 45 = 30 (plan) + 10 (promo) + 5 (regalo)
    expect(by(r, "commit")).toBe(50); // el saldo pagado sigue intacto
    r = (await b.ingest(a.customerId, img(200))).account; // 7,2 €
    expect(by(r, "commit")).toBeCloseTo(42.8, 4);
  });
});

describe("bloqueo al llegar a 0 (Free y Pro)", () => {
  it.each(["free", "pro"] as const)("%s: se bloquea y rechaza nuevas peticiones", async plan => {
    const a = await b.signup({ name: "A", email: "a@x", plan });
    const r = await b.ingest(a.customerId, img(5000));
    expect(balance(r.account)).toBe(0);
    expect(r.account.blocked).toBe(true);
    expect(r.account.overageAccrued).toBe(0);
    expect(r.account.alerts[0].type).toBe("zero_balance");
    expect((await b.ingest(a.customerId, img(1))).rejected).toBe(true);
  });
  it("comprar un bundle desbloquea la cuenta", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "free" });
    await b.ingest(a.customerId, img(500));
    const r = await b.buyBundle(a.customerId, "b50", "pur_unblock");
    expect(r.blocked).toBe(false);
    expect(balance(r)).toBe(55);
  });
});

describe("bundles: regalo solo tras el webhook de pago, emparejado por id de compra", () => {
  beforeEach(() => { process.env.MOCK_AUTO_PAYMENT_WEBHOOK = "0"; });
  const paid = (cid: string, id: string, status: "paid" | "failed" = "paid") =>
    handleMetronomeEvent({ id, type: "payment_gate.payment_status", properties: { customer_id: cid, contract_id: cid, workflow_type: "manual_commit", payment_status: status } }, { verified: true });

  it("sin webhook no hay regalo; con payment_status=paid se concede una sola vez", async () => {
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
  it("si el pago falla: no hay commit ni regalo y la compra queda como fallida", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.buyBundle(a.customerId, "b50", "pur_fail_1");
    await paid(a.customerId, "evt-fail-1", "failed");
    const r = (await b.get(a.customerId))!;
    expect(by(r, "commit")).toBe(0);
    expect(by(r, "gift")).toBe(0);
    expect(r.invoices.find(i => i.externalId === "purchase:pur_fail_1")?.status).toBe("void");
    expect(getPurchase("pur_fail_1")?.status).toBe("failed");
  });
  it("repetir la compra con el mismo id no cobra dos veces", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.buyBundle(a.customerId, "b50", "pur_same");
    const r = await b.buyBundle(a.customerId, "b50", "pur_same");
    expect(r.invoices.filter(i => i.type === "commit")).toHaveLength(1);
    expect(by(r, "commit")).toBe(50);
  });
});

describe("ingesta idempotente por id de petición", () => {
  it("un reintento con el mismo requestId no se cobra otra vez", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.ingest(a.customerId, img(100, "req-1"));
    const r = await b.ingest(a.customerId, [...img(100, "req-1"), ...img(100, "req-2")]);
    expect(r.duplicates).toBe(1);
    expect(balance(r.account)).toBeCloseTo(30 - 7.2, 4);
    expect(new Set(r.account.usage.map(u => u.requestId))).toEqual(new Set(["req-1", "req-2"]));
  });
});

describe("Scale: uso extra y cobro anticipado por umbral", () => {
  it("no bloquea, acumula el exceso y cobra 300 € por adelantado al llegar al umbral", async () => {
    const a = await b.signup({ name: "S", email: "s@x", plan: "scale" });
    let r = await b.ingest(a.customerId, img(10_000)); // 320 € − 250 € = 70 €
    expect(r.rejected).toBe(false);
    expect(r.account.overageAccrued).toBe(70);
    expect(r.account.invoices.some(i => i.type === "threshold")).toBe(false);
    r = await b.ingest(a.customerId, img(10_000)); // +320 € → 390 €
    expect(r.account.invoices[0]).toMatchObject({ type: "threshold", amount: 300 });
    expect(r.account.spendPrepaid).toBe(300);
    expect(draftInvoice(r.account).amount).toBe(90); // 390 − 300 ya cobrados
    expect(r.account.alerts.some(x => x.type === "payment" && x.message.includes("adelantado"))).toBe(true);
  });
  it("recarga automática y cobro por umbral son excluyentes", async () => {
    const a = await b.signup({ name: "S", email: "s@x", plan: "scale" });
    await expect(b.setAutoRecharge(a.customerId, true)).rejects.toThrow(/umbral/);
    await b.setSpendThreshold(a.customerId, false);
    const r = await b.setAutoRecharge(a.customerId, true);
    expect(r.autoRecharge).toBe(true);
    await expect(b.setSpendThreshold(a.customerId, true)).rejects.toThrow(/recarga/);
  });
  it("solo en Scale", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await expect(b.setSpendThreshold(a.customerId, true)).rejects.toThrow(/Scale/);
  });
});

describe("recarga automática (recargar hasta 50 €)", () => {
  it("al bajar de 10 € cobra lo necesario para volver a 50 €", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.setAutoRecharge(a.customerId, true);
    const r = (await b.ingest(a.customerId, img(600))).account; // 21,6 € → quedan 8,4 €
    expect(balance(r)).toBeCloseTo(50, 4);
    expect(r.invoices[0]).toMatchObject({ amount: 41.6, type: "commit" });
    expect(r.alerts[0].type).toBe("auto_recharge");
  });
  it("no está disponible en Free", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "free" });
    await expect(b.setAutoRecharge(a.customerId, true)).rejects.toThrow(/Pro y Scale/);
  });
});

describe("códigos promocionales", () => {
  it("BIENVENIDA10: 10 € que caducan a los 30 días; una vez por cliente", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "free" });
    const r = await b.redeemPromo(a.customerId, " bienvenida10 ");
    const promo = r.credits.find(c => c.kind === "promo")!;
    expect(promo).toMatchObject({ amount: 10, remaining: 10, reference: "BIENVENIDA10", expiresAt: "2026-10-01T00:00:00.000Z" });
    await expect(b.redeemPromo(a.customerId, "BIENVENIDA10")).rejects.toThrow(/Ya has canjeado/);
    await expect(b.redeemPromo(a.customerId, "NOEXISTE")).rejects.toThrow(/no válido/);
  });
  it("el saldo promocional caduca", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    at(10);
    await b.redeemPromo(a.customerId, "BIENVENIDA10"); // caduca el 10 de octubre
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 11)));
    const r = (await b.get(a.customerId))!;
    expect(by(r, "promo")).toBe(0);
  });
});

describe("alertas", () => {
  it("avisa una sola vez al cruzar el 20 % de los créditos del plan", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    let r = (await b.ingest(a.customerId, img(700))).account; // 25,2 € → quedan 4,8 € (< 6 €)
    expect(r.alerts[0].type).toBe("low_balance");
    r = (await b.ingest(a.customerId, img(10))).account;
    expect(r.alerts.filter(x => x.type === "low_balance")).toHaveLength(1);
  });
  it("el webhook de saldo 0 corta el acceso en Free/Pro (aunque el saldo local no sea 0) y un pago lo restablece", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await handleMetronomeEvent({ id: "z1", type: "alerts.low_remaining_contract_credit_and_commit_balance_reached", properties: { customer_id: a.customerId, threshold: 0, remaining_balance: 0 } }, { verified: true });
    let r = (await b.get(a.customerId))!;
    expect(r.blocked).toBe(true);
    expect((await b.ingest(a.customerId, img(1))).rejected).toBe(true);
    await handleMetronomeEvent({ id: "p1", type: "payment_gate.payment_status", properties: { customer_id: a.customerId, contract_id: a.customerId, workflow_type: "manual_commit", payment_status: "paid" } }, { verified: true });
    r = (await b.get(a.customerId))!;
    expect(r.blocked).toBe(false);
  });
  it("…pero no en Scale (overage)", async () => {
    const a = await b.signup({ name: "S", email: "s@x", plan: "scale" });
    await handleMetronomeEvent({ id: "z2", type: "alerts.low_remaining_contract_credit_and_commit_balance_reached", properties: { customer_id: a.customerId, threshold: 0, remaining_balance: 0 } }, { verified: true });
    expect((await b.get(a.customerId))!.blocked).toBe(false);
  });
});

describe("próxima factura, uso de 30 días y recomendador", () => {
  it("la próxima factura suma el exceso y la cuota del mes siguiente (o la del plan programado)", async () => {
    const a = await b.signup({ name: "S", email: "s@x", plan: "scale" });
    const r = (await b.ingest(a.customerId, img(10_000))).account;
    const u = upcomingInvoice(r);
    expect(u.totalDueEur).toBe(70 + 199);
    expect(u.creditsAppliedEur).toBe(250);
    expect(u.lines.map(l => l.type)).toEqual(["usage", "applied_commit_or_credit", "subscription"]);
    const down = await b.changePlan(a.customerId, "pro");
    expect(upcomingInvoice(down).lines.at(-1)).toMatchObject({ type: "subscription", totalEur: 29 });
  });
  it("uso de 30 días con la forma UsageLast30Days y plan recomendado", async () => {
    at(25);
    const a = await b.signup({ name: "A", email: "a@x", plan: "free" });
    await b.buyBundle(a.customerId, "b200", "pur_u30");
    await b.ingest(a.customerId, img(100));
    const v = withInsights((await b.get(a.customerId))!);
    expect(v.usage30!.metrics.images.total).toBe(100);
    expect(v.usage30!.metrics.images.daily).toHaveLength(30);
    expect(v.usage30!.totalListCostEur).toBe(4);
  });
  it("recommendPlan: cuota + exceso sobre los créditos, igual que el helper del setup", () => {
    const u = usageLast30DaysFromDaily("c", [{ day: "2026-09-20", metric: "images", quantity: 2500, cost: 0 }], new Date(Date.UTC(2026, 8, 25))); // 100 € a precio de lista
    const r = recommendPlan(u, "free");
    expect(r.estimates.map(e => e.totalMonthlyEur)).toEqual([95, 89, 199]);
    expect(r.recommended).toBe("pro");
    expect(r.savingsVsCurrentEur).toBe(6);
  });
  it("propuesta Enterprise con la forma EnterpriseContractSummary", () => {
    const p = enterpriseProposal({ customerId: "lead_1", commitAmountEur: 24_000 }, new Date(Date.UTC(2026, 8, 25, 10, 30)));
    expect(p).toMatchObject({ commitType: "POSTPAID", commitAmountEur: 24_000, monthlyEquivalentEur: 2000, startingAt: "2026-09-25T10:00:00.000Z", endingBefore: "2027-09-25T10:00:00.000Z" });
    expect(p.savingsVsListPct).toBe(22); // (20 % + 20 % + 25 %) / 3
  });
});

describe("persistencia", () => {
  it("guarda las cuentas en data/db.json y sobreviven a un reinicio", async () => {
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
