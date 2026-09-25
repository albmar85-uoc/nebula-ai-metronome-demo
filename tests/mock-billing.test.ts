import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { balance, draftInvoice, mockBilling as b } from "@/lib/billing/mock";
import { _resetCache } from "@/lib/store";
import { freshDataDir } from "./helpers";

// Imágenes: 0,04 € sin descuento; Pro 0,036 €; Scale 0,032 €.
const img = (quantity: number) => [{ metric: "images" as const, quantity }];

beforeEach(() => {
  freshDataDir();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 0, 0, 0))); // 16 sep: queda justo la mitad de septiembre (30 días)
});
afterEach(() => vi.useRealTimers());

describe("alta", () => {
  it("cobra la cuota y concede los créditos del plan", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    expect(balance(a)).toBe(30);
    expect(a.invoices[0]).toMatchObject({ amount: 29, status: "paid", type: "subscription" });
    const f = await b.signup({ name: "F", email: "f@x", plan: "free" });
    expect(f.invoices).toHaveLength(0); // Free no genera cobro
    expect(balance(f)).toBe(5);
  });
});

describe("prorrateo al cambiar de plan", () => {
  it("upgrade Pro → Scale a mitad de mes cobra la diferencia prorrateada y añade créditos proporcionales", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    const r = await b.changePlan(a.customerId, "scale");
    expect(r.plan).toBe("scale");
    expect(r.invoices[0]).toMatchObject({ amount: 85, type: "proration" }); // (199 - 29) × 0,5
    const extra = r.credits.find(c => c.label.includes("prorrateados"));
    expect(extra).toMatchObject({ kind: "recurring", amount: 110 }); // (250 - 30) × 0,5
    expect(balance(r)).toBe(140);
  });
  it("downgrade no cobra ni reembolsa y desactiva la recarga automática en Free", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.setAutoRecharge(a.customerId, true);
    const r = await b.changePlan(a.customerId, "free");
    expect(r.invoices).toHaveLength(1); // solo la cuota inicial
    expect(r.autoRecharge).toBe(false);
  });
});

describe("orden de consumo: mensual → regalo → commit", () => {
  it("agota los créditos mensuales, después el regalo y por último el commit", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.buyBundle(a.customerId, "b50"); // 50 € commit + 5 € regalo
    let r = (await b.ingest(a.customerId, img(1000))).account; // 36 €
    const by = (k: string) => r.credits.filter(c => c.kind === k).reduce((s, c) => s + c.remaining, 0);
    expect(by("recurring")).toBe(0);
    expect(by("gift")).toBe(0);
    expect(by("commit")).toBe(49); // 36 - 30 - 5 = 1 € del commit
    r = (await b.ingest(a.customerId, img(100))).account; // 3,6 €
    expect(by("commit")).toBeCloseTo(45.4, 4);
  });
});

describe("bloqueo al llegar a 0 (Free y Pro)", () => {
  it.each(["free", "pro"] as const)("%s: se bloquea y rechaza nuevas peticiones", async plan => {
    const a = await b.signup({ name: "A", email: "a@x", plan });
    const r = await b.ingest(a.customerId, img(5000));
    expect(balance(r.account)).toBe(0);
    expect(r.account.blocked).toBe(true);
    expect(r.account.overageAccrued).toBe(0); // no hay uso extra facturable
    expect(r.account.alerts[0].type).toBe("zero_balance");
    const again = await b.ingest(a.customerId, img(1));
    expect(again.rejected).toBe(true);
  });
  it("comprar un bundle desbloquea la cuenta", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "free" });
    await b.ingest(a.customerId, img(500));
    const r = await b.buyBundle(a.customerId, "b50");
    expect(r.blocked).toBe(false);
    expect(balance(r)).toBe(55);
  });
});

describe("uso extra en Scale", () => {
  it("no bloquea y acumula el exceso para fin de mes", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "scale" });
    const r = await b.ingest(a.customerId, img(10_000)); // 320 € con 20 % de descuento
    expect(r.rejected).toBe(false);
    expect(r.account.blocked).toBe(false);
    expect(r.account.overageAccrued).toBe(70);
    expect(r.account.alerts[0]).toMatchObject({ type: "zero_balance" });
    expect(draftInvoice(r.account).amount).toBe(70);
  });
});

describe("recarga automática", () => {
  it("al bajar de 10 € compra el bundle de 50 € (+5 € de regalo)", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    await b.setAutoRecharge(a.customerId, true);
    const r = (await b.ingest(a.customerId, img(600))).account; // 21,6 € → quedan 8,4 €
    expect(balance(r)).toBeCloseTo(63.4, 4);
    expect(r.invoices[0]).toMatchObject({ amount: 50, type: "commit" });
    expect(r.alerts[0].type).toBe("auto_recharge");
  });
  it("no está disponible en Free", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "free" });
    await expect(b.setAutoRecharge(a.customerId, true)).rejects.toThrow(/Pro y Scale/);
  });
});

describe("alertas", () => {
  it("avisa una sola vez al cruzar el 20 % del saldo", async () => {
    const a = await b.signup({ name: "A", email: "a@x", plan: "pro" });
    let r = (await b.ingest(a.customerId, img(700))).account; // 25,2 € → quedan 4,8 € (< 6 €)
    expect(r.alerts[0].type).toBe("low_balance");
    r = (await b.ingest(a.customerId, img(10))).account;
    expect(r.alerts.filter(x => x.type === "low_balance")).toHaveLength(1);
  });
});

describe("persistencia", () => {
  it("guarda las cuentas en data/db.json y sobreviven a un reinicio", async () => {
    const a = await b.signup({ name: "Persistente", email: "p@x", plan: "pro" });
    await b.ingest(a.customerId, img(10));
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, "db.json"))).toBe(true);
    _resetCache(); // simula reinicio del proceso
    const again = await b.get(a.customerId);
    expect(again?.name).toBe("Persistente");
    expect(balance(again!)).toBeCloseTo(29.64, 4);
    expect(again?.daily?.[0]).toMatchObject({ metric: "images", quantity: 10 });
  });
});
