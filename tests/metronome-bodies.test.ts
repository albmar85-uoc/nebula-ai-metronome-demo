import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMetronomeIds, type MetronomeIds } from "@/lib/billing/metronome-config";
import { PRIORITY, buildBundleEdit, buildContractBody, buildCustomerBody, buildGiftEdit, buildIngestEvents, mapBalance, thresholdConfig } from "@/lib/billing/metronome";

// Sin red: se comprueban los cuerpos que se enviarían a Metronome.
let ids: MetronomeIds;
beforeAll(() => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ids-")), "metronome-ids.json");
  fs.writeFileSync(f, JSON.stringify({
    // Misma forma que escribe metronome-setup/src/setup.ts (tipo MetronomeIds de src/ids.ts)
    generated_at: "2026-09-25T18:00:00Z", base_url: "https://api.metronome.com", dry_run: true,
    credit_types: { EUR: "ct-eur" },
    billable_metrics: { input_tokens: "bm-in", output_tokens: "bm-out", images: "bm-img" },
    products: { usage: { input_tokens: "p-in", output_tokens: "p-out", images: "p-img" }, subscription: { pro: "p-sub-pro", scale: "p-sub-scale" }, fixed: { plan_credits: "p-rc", bundle_commit: "p-commit", bundle_bonus: "p-gift", auto_recharge: "p-auto" } },
    rate_card: { id: "rc-1", alias: "nebula_eur" },
    alerts: { zero_balance: "al-0", zero_balance_uniqueness_key: "nebula-zero-balance-eur-v1" },
  }));
  process.env.METRONOME_IDS_FILE = f;
  ids = loadMetronomeIds();
});

describe("configuración de IDs", () => {
  it("lee el fichero de IDs y cae a variables de entorno", () => {
    expect(ids).toMatchObject({ rateCardId: "rc-1", creditTypeId: "ct-eur", usageProducts: { images: "p-img" }, subscriptionProducts: { pro: "p-sub-pro" }, recurringCreditProduct: "p-rc", giftCreditProduct: "p-gift", prepaidCommitProduct: "p-commit", autoRechargeProduct: "p-auto", amountScale: 1, fromSetup: true, hasGlobalZeroAlert: true });
    const saved = process.env.METRONOME_IDS_FILE;
    process.env.METRONOME_IDS_FILE = "/no/existe.json";
    expect(() => loadMetronomeIds()).toThrow(/Falta configuración de Metronome/);
    Object.assign(process.env, {
      METRONOME_CREDIT_TYPE_ID: "env-ct", METRONOME_RATE_CARD_ID: "env-rc", METRONOME_PRODUCT_INPUT_TOKENS: "e-in", METRONOME_PRODUCT_OUTPUT_TOKENS: "e-out",
      METRONOME_PRODUCT_IMAGES: "e-img", METRONOME_PRODUCT_RECURRING_CREDIT: "e-rc", METRONOME_PRODUCT_GIFT_CREDIT: "e-g", METRONOME_PRODUCT_PREPAID_COMMIT: "e-c",
    });
    expect(loadMetronomeIds()).toMatchObject({ source: "variables de entorno", rateCardId: "env-rc", usageProducts: { images: "e-img" } });
    process.env.METRONOME_IDS_FILE = saved;
  });
});

describe("cuerpos de la API", () => {
  it("cliente enlazado a Stripe con charge_automatically", () => {
    const body = buildCustomerBody({ name: "A", email: "a@x", plan: "pro", stripeCustomerId: "cus_123", appUserId: "usr_1" });
    expect(body.ingest_aliases).toEqual(["usr_1"]);
    expect(body.customer_billing_provider_configurations?.[0]).toMatchObject({ billing_provider: "stripe", delivery_method: "direct_to_billing_provider", configuration: { stripe_customer_id: "cus_123", stripe_collection_method: "charge_automatically" } });
    expect(() => buildCustomerBody({ name: "A", email: "a@x", plan: "pro", appUserId: "u" })).toThrow();
  });
  it("contrato Pro: suscripción prorrateada, créditos recurrentes y overrides del 10 %", () => {
    const c = buildContractBody(ids, { customerId: "m-1", plan: "pro", appUserId: "u", startingAt: "2026-09-16T10:00:00.000Z" });
    expect(c.rate_card_id).toBe("rc-1");
    expect(c.subscriptions?.[0]).toMatchObject({ subscription_rate: { product_id: "p-sub-pro", billing_frequency: "MONTHLY" }, collection_schedule: "ADVANCE", proration: { is_prorated: true, invoice_behavior: "BILL_IMMEDIATELY" } });
    expect(c.recurring_credits?.[0]).toMatchObject({ product_id: "p-rc", access_amount: { unit_price: 30, credit_type_id: "ct-eur" }, priority: PRIORITY.recurring, recurrence_frequency: "MONTHLY", applicable_product_ids: ["p-in", "p-out", "p-img"] });
    expect(c.custom_fields).toEqual({ nebula_plan: "pro" });
    expect(c.overrides).toHaveLength(3);
    expect(c.overrides?.every(o => o.type === "MULTIPLIER" && o.multiplier === 0.9)).toBe(true);
    expect(c.billing_provider_configuration).toMatchObject({ billing_provider: "stripe" });
  });
  it("cambio de plan: contrato nuevo con transition RENEWAL que conserva la recarga automática", () => {
    const c = buildContractBody(ids, { customerId: "m-1", plan: "scale", appUserId: "u", startingAt: "2026-09-16T10:00:00.000Z", transitionFrom: "k-old", autoRecharge: true });
    expect(c.transition).toEqual({ type: "RENEWAL", from_contract_id: "k-old" });
    expect(c.prepaid_balance_threshold_configuration).toMatchObject({ is_enabled: true, threshold_amount: 10, commit: { product_id: "p-auto", rollover_fraction: 1 } });
    expect(c.overrides?.[0].multiplier).toBe(0.8);
    const toFree = buildContractBody(ids, { customerId: "m-1", plan: "free", appUserId: "u", startingAt: "2026-10-01T00:00:00.000Z", transitionFrom: "k-old", autoRecharge: true });
    expect(toFree.prepaid_balance_threshold_configuration).toBeUndefined(); // Free no admite recarga automática
  });
  it("contrato Free: sin suscripción ni overrides", () => {
    const c = buildContractBody(ids, { customerId: "m-1", plan: "free", appUserId: "u", startingAt: "2026-09-16T10:00:00.000Z" });
    expect(c.subscriptions).toBeUndefined();
    expect(c.overrides).toEqual([]);
    expect(c.recurring_credits?.[0].access_amount.unit_price).toBe(5); // EUR en unidades enteras
  });
  it("bundle: commit prepagado con pago en Stripe (PaymentIntent) y regalo aparte", () => {
    const e = buildBundleEdit(ids, { customerId: "m", contractId: "k", bundle: "b200" });
    expect(e.add_commits?.[0]).toMatchObject({ type: "PREPAID", product_id: "p-commit", priority: PRIORITY.commit, payment_gate_config: { payment_gate_type: "STRIPE", stripe_config: { payment_type: "PAYMENT_INTENT" } } });
    expect(e.add_commits?.[0].access_schedule?.schedule_items[0].amount).toBe(200);
    expect(e.add_commits?.[0].invoice_schedule?.schedule_items?.[0].amount).toBe(200);
    expect(e.add_commits?.[0].applicable_product_ids).toEqual(["p-in", "p-out", "p-img"]);
    expect(e.add_commits?.[0].rollover_fraction).toBe(1);
    const g = buildGiftEdit(ids, { customerId: "m", contractId: "k", bundle: "b200" });
    expect(g?.add_credits?.[0]).toMatchObject({ product_id: "p-gift", priority: PRIORITY.gift });
    expect(g?.add_credits?.[0].access_schedule.schedule_items[0].amount).toBe(30);
  });
  it("recarga automática: umbral 10 € y recarga hasta 60 € (≈ bundle de 50 €) con el producto auto_recharge", () => {
    expect(thresholdConfig(ids)).toMatchObject({ is_enabled: true, threshold_amount: 10, recharge_to_amount: 60, commit: { product_id: "p-auto" }, payment_gate_config: { payment_gate_type: "STRIPE" } });
  });
  it("ingesta: un evento por event_type del setup (texto e imágenes)", () => {
    const evs = buildIngestEvents(ids, "usr_1", [{ metric: "input_tokens", quantity: 10 }, { metric: "output_tokens", quantity: 5 }, { metric: "images", quantity: 2 }]);
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ customer_id: "usr_1", event_type: "nebula_llm_request", properties: { input_tokens: 10, output_tokens: 5 } });
    expect(evs[1]).toMatchObject({ event_type: "nebula_image_generation", properties: { images: 2 } });
    expect(evs[0].transaction_id).not.toBe(evs[1].transaction_id);
  });
  it("mapea saldos de Metronome a CreditGrant (céntimos → euros)", () => {
    const at = new Date("2026-09-16T12:00:00Z");
    const g = mapBalance(ids, { id: "c1", type: "CREDIT", name: "Créditos mensuales Pro", recurring_credit_id: "r1", product: { id: "p-rc", name: "x" }, balance: 12.34, access_schedule: { schedule_items: [{ id: "s", amount: 30, starting_at: "2026-09-01T00:00:00Z", ending_before: "2026-10-01T00:00:00Z" }] } } as never, at);
    expect(g).toMatchObject({ kind: "recurring", amount: 30, remaining: 12.34 });
    const c = mapBalance(ids, { id: "c2", type: "PREPAID", product: { id: "p-commit", name: "Commit" }, balance: 50, created_at: "2026-09-10T00:00:00Z", access_schedule: { schedule_items: [] } } as never, at);
    expect(c.kind).toBe("commit");
  });
});
