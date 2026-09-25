import { beforeEach, describe, expect, it } from "vitest";
import { mockBilling } from "@/lib/billing/mock";
import { handleMetronomeEvent, signMetronome, verifyMetronomeSignature } from "@/lib/webhooks";
import { _resetCache } from "@/lib/store";
import { freshDataDir } from "./helpers";

const H = (h: Record<string, string>) => ({ get: (n: string) => h[Object.keys(h).find(k => k.toLowerCase() === n.toLowerCase()) ?? ""] ?? null });

// Vector de prueba oficial: https://docs.metronome.com/guides/platform-configuration/setup-webhooks
const DOC_BODY = `{
  "id": "b2c9e307-624e-4e7d-a5a4-1b74107d78c4",
  "type": "widget_created",
  "properties": {
    "customer_id": "5f794d50-085a-4db6-8d15-286e518b7225",
    "widget_id": "0891458d-b6f0-4fdd-a41e-380aae1a1e38"
  }
}`;
const DOC_DATE = "Mon, 02 Jan 2006 22:04:05 GMT";
const DOC_SIG = "b82652fa2246cf1d8a27e591f155c865f68b46c19b9213fd9c052f2419b4742b";
const SECRET = "correct-horse-battery-staple";

describe("Metronome webhook signatures", () => {
  it("validates the documentation example", () => {
    expect(verifyMetronomeSignature(DOC_BODY, H({ "X-Metronome-Date": DOC_DATE, "Metronome-Webhook-Signature": DOC_SIG }), SECRET, { now: +new Date(DOC_DATE) })).toEqual({ ok: true });
  });
  it("accepts the Date header when X-Metronome-Date is missing (compatibility)", () => {
    expect(verifyMetronomeSignature(DOC_BODY, H({ Date: DOC_DATE, "Metronome-Webhook-Signature": DOC_SIG }), SECRET, { now: +new Date(DOC_DATE) }).ok).toBe(true);
  });
  it("rejects a tampered body, wrong secret and stale notifications", () => {
    const h = H({ "X-Metronome-Date": DOC_DATE, "Metronome-Webhook-Signature": DOC_SIG });
    expect(verifyMetronomeSignature(DOC_BODY + " ", h, SECRET, { now: +new Date(DOC_DATE) }).ok).toBe(false);
    expect(verifyMetronomeSignature(DOC_BODY, h, "otro", { now: +new Date(DOC_DATE) }).ok).toBe(false);
    expect(verifyMetronomeSignature(DOC_BODY, h, SECRET).ok).toBe(false); // 2006: fuera de la ventana de 5 min
    expect(verifyMetronomeSignature(DOC_BODY, H({}), SECRET).ok).toBe(false);
  });
});

describe("webhook processing", () => {
  beforeEach(() => { freshDataDir(); });
  it("stores the low-balance alert on the account and dedupes by id", async () => {
    const a = await mockBilling.signup({ name: "A", email: "a@x", plan: "pro" });
    const ev = { id: "evt-1", type: "alerts.low_remaining_contract_credit_and_commit_balance_reached", properties: { customer_id: a.customerId, remaining_balance: 4.5, threshold: 6, alert_name: "Saldo bajo (20 %)" } };
    expect((await handleMetronomeEvent(ev, { verified: true })).status).toBe("stored");
    expect((await handleMetronomeEvent(ev, { verified: true })).status).toBe("duplicate");
    const got = await mockBilling.get(a.customerId);
    const al = got!.alerts.find(x => x.source === "webhook")!;
    expect(al).toMatchObject({ type: "low_balance", verified: true });
    expect(al.message).toContain("€4.50");
  });
  it("balance 0 → zero_balance (and cut-off on Pro); payment_gate.* are stored as payment notices", async () => {
    const a = await mockBilling.signup({ name: "A", email: "a@x", plan: "pro" });
    await handleMetronomeEvent({ id: "e2", type: "alerts.low_remaining_contract_credit_and_commit_balance_reached", properties: { customer_id: a.customerId, threshold: 0, remaining_balance: 0 } }, { verified: false });
    expect((await mockBilling.get(a.customerId))!.blocked).toBe(true);
    const r = await handleMetronomeEvent({ id: "e3", type: "payment_gate.threshold_reached", properties: { customer_id: a.customerId, contract_id: "c-1", workflow_type: "spend" } }, { verified: true });
    expect(r).toMatchObject({ status: "stored", action: "threshold_charge_started" });
    await handleMetronomeEvent({ id: "e4", type: "payment_gate.payment_status", properties: { customer_id: a.customerId, contract_id: "c-1", workflow_type: "spend", payment_status: "paid" } }, { verified: true });
    const got = await mockBilling.get(a.customerId);
    expect(got!.alerts.map(x => x.type)).toEqual(expect.arrayContaining(["zero_balance", "payment"]));
    expect(got!.alerts.some(x => x.message.includes("spend threshold"))).toBe(true);
    expect(got!.blocked).toBe(false); // un pago confirmado levanta el corte
  });
  it("a failed threshold charge cuts off access", async () => {
    const a = await mockBilling.signup({ name: "A", email: "a@x", plan: "pro" });
    await handleMetronomeEvent({ id: "f1", type: "payment_gate.payment_status", properties: { customer_id: a.customerId, contract_id: "c", workflow_type: "spend", payment_status: "failed", error_message: "tarjeta rechazada" } }, { verified: true });
    const got = await mockBilling.get(a.customerId);
    expect(got!.blocked).toBe(true);
    expect(got!.alerts.some(x => x.message.includes("tarjeta rechazada"))).toBe(true);
  });
  it("deduplication is persisted to disk and survives a restart", async () => {
    const a = await mockBilling.signup({ name: "A", email: "a@x", plan: "pro" });
    const ev = { id: "evt-persist", type: "payment_gate.payment_pending_action_required", properties: { customer_id: a.customerId, contract_id: "c" } };
    expect((await handleMetronomeEvent(ev, { verified: true })).status).toBe("stored");
    _resetCache(); // reinicio del proceso
    expect((await handleMetronomeEvent(ev, { verified: true })).status).toBe("duplicate");
  });
  it("unknown customers and unhandled types do not fail", async () => {
    expect((await handleMetronomeEvent({ id: "u1", type: "payment_gate.payment_status", properties: { customer_id: "nadie", contract_id: "c", payment_status: "paid" } }, { verified: true })).status).toBe("unknown_customer");
    expect((await handleMetronomeEvent({ id: "u2", type: "contract.edit", properties: {} }, { verified: true })).status).toBe("ignored");
  });
  it("the generated signature matches verification", () => {
    const date = new Date().toUTCString();
    const sig = signMetronome("s", date, "{}");
    expect(verifyMetronomeSignature("{}", H({ "X-Metronome-Date": date, "Metronome-Webhook-Signature": sig }), "s").ok).toBe(true);
  });
});
