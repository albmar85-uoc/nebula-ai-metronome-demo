import { beforeEach, describe, expect, it } from "vitest";
import { mockBilling } from "@/lib/billing/mock";
import { handleMetronomeEvent, signMetronome, verifyMetronomeSignature } from "@/lib/webhooks";
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

describe("firma de webhooks de Metronome", () => {
  it("valida el ejemplo de la documentación", () => {
    expect(verifyMetronomeSignature(DOC_BODY, H({ "X-Metronome-Date": DOC_DATE, "Metronome-Webhook-Signature": DOC_SIG }), SECRET, { now: +new Date(DOC_DATE) })).toEqual({ ok: true });
  });
  it("acepta la cabecera Date si falta X-Metronome-Date (compatibilidad)", () => {
    expect(verifyMetronomeSignature(DOC_BODY, H({ Date: DOC_DATE, "Metronome-Webhook-Signature": DOC_SIG }), SECRET, { now: +new Date(DOC_DATE) }).ok).toBe(true);
  });
  it("rechaza cuerpo alterado, secreto incorrecto y notificaciones antiguas", () => {
    const h = H({ "X-Metronome-Date": DOC_DATE, "Metronome-Webhook-Signature": DOC_SIG });
    expect(verifyMetronomeSignature(DOC_BODY + " ", h, SECRET, { now: +new Date(DOC_DATE) }).ok).toBe(false);
    expect(verifyMetronomeSignature(DOC_BODY, h, "otro", { now: +new Date(DOC_DATE) }).ok).toBe(false);
    expect(verifyMetronomeSignature(DOC_BODY, h, SECRET).ok).toBe(false); // 2006: fuera de la ventana de 5 min
    expect(verifyMetronomeSignature(DOC_BODY, H({}), SECRET).ok).toBe(false);
  });
});

describe("procesado de webhooks", () => {
  beforeEach(() => { freshDataDir(); });
  it("guarda la alerta de saldo bajo en la cuenta y deduplica por id", async () => {
    const a = await mockBilling.signup({ name: "A", email: "a@x", plan: "pro" });
    const ev = { id: "evt-1", type: "alerts.low_remaining_contract_credit_and_commit_balance_reached", properties: { customer_id: a.customerId, remaining_balance: 4.5, threshold: 6, alert_name: "Saldo bajo (20 %)" } };
    expect((await handleMetronomeEvent(ev, { verified: true })).status).toBe("stored");
    expect((await handleMetronomeEvent(ev, { verified: true })).status).toBe("duplicate");
    const got = await mockBilling.get(a.customerId);
    const al = got!.alerts.find(x => x.source === "webhook")!;
    expect(al).toMatchObject({ type: "low_balance", verified: true });
    expect(al.message).toContain("4,50");
  });
  it("saldo 0 → zero_balance; pago confirmado libera el regalo pendiente", async () => {
    const a = await mockBilling.signup({ name: "A", email: "a@x", plan: "pro" });
    await handleMetronomeEvent({ id: "e2", type: "alerts.low_remaining_contract_credit_and_commit_balance_reached", properties: { customer_id: a.customerId, remaining_balance: 0 } }, { verified: false });
    const released: string[] = [];
    await handleMetronomeEvent({ id: "e3", type: "payment_gate.payment_status", properties: { customer_id: a.customerId, contract_id: "c-1", workflow_type: "manual_commit", payment_status: "paid" } }, { verified: true, onPaymentPaid: async c => { released.push(c); } });
    expect(released).toEqual(["c-1"]);
    const got = await mockBilling.get(a.customerId);
    expect(got!.alerts.map(x => x.type)).toEqual(expect.arrayContaining(["zero_balance", "payment"]));
  });
  it("la firma generada coincide con la verificación", () => {
    const date = new Date().toUTCString();
    const sig = signMetronome("s", date, "{}");
    expect(verifyMetronomeSignature("{}", H({ "X-Metronome-Date": date, "Metronome-Webhook-Signature": sig }), "s").ok).toBe(true);
  });
});
