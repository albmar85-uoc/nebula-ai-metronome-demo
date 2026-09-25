// Verificación y procesado de webhooks de Metronome.
// Firma (https://docs.metronome.com/guides/platform-configuration/setup-webhooks#verify-signatures):
//   HMAC_SHA256(secret, X-Metronome-Date + "\n" + cuerpo_en_bruto) en hexadecimal == Metronome-Webhook-Signature
//   Metronome envía también "Date" con el mismo valor; se prefiere X-Metronome-Date (los proxies pueden reescribir Date).
//   Se deben ignorar notificaciones de más de 5 minutos (y deduplicar por id).
import { createHmac, timingSafeEqual } from "node:crypto";
import { eur } from "./catalog";
import { addAlert, findLinkByMetronomeId, getAccount, markWebhookSeen } from "./store";
import type { Alert } from "./billing/types";

type HeaderGetter = { get(name: string): string | null };

export function signMetronome(secret: string, date: string, rawBody: string) {
  return createHmac("sha256", secret).update(`${date}\n${rawBody}`).digest("hex");
}

export function verifyMetronomeSignature(rawBody: string, headers: HeaderGetter, secret: string, opts: { now?: number; toleranceMs?: number } = {}): { ok: true } | { ok: false; reason: string } {
  const date = headers.get("x-metronome-date") ?? headers.get("date");
  const sig = headers.get("metronome-webhook-signature");
  if (!date || !sig) return { ok: false, reason: "Faltan las cabeceras X-Metronome-Date/Date o Metronome-Webhook-Signature" };
  const ts = new Date(date).valueOf();
  if (Number.isNaN(ts)) return { ok: false, reason: "Fecha de la cabecera inválida" };
  const tol = opts.toleranceMs ?? 5 * 60 * 1000;
  const now = opts.now ?? Date.now();
  if (tol > 0 && Math.abs(now - ts) > tol) return { ok: false, reason: "Notificación fuera de la ventana de 5 minutos" };
  const expected = Buffer.from(signMetronome(secret, date, rawBody));
  const got = Buffer.from(sig.trim());
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, reason: "Firma no válida" };
  return { ok: true };
}

export type MetronomeEvent = { id: string; type: string; properties?: Record<string, unknown>; [k: string]: unknown };

/** Dónde guardar la alerta: cuenta simulada (id local) o id de cliente de Metronome (modo en vivo). */
function alertKey(customerId: string | undefined): string | null {
  if (!customerId) return null;
  if (getAccount(customerId)) return customerId;
  if (findLinkByMetronomeId(customerId)) return customerId;
  return null;
}

export async function handleMetronomeEvent(ev: MetronomeEvent, opts: { verified: boolean; onPaymentPaid?: (contractId: string) => Promise<unknown> }) {
  if (!ev?.id || !ev?.type) return { status: "ignored", reason: "evento sin id/type" } as const;
  if (!markWebhookSeen(ev.id)) return { status: "duplicate" } as const;
  const p = ev.properties ?? {};
  const key = alertKey(p.customer_id as string | undefined);
  const push = (type: Alert["type"], message: string) => {
    if (!key) return false;
    addAlert(key, { id: `wh_${ev.id}`, ts: (p.timestamp as string) ?? new Date().toISOString(), type, message, source: "webhook", verified: opts.verified });
    return true;
  };

  if (ev.type.startsWith("alerts.")) {
    // p. ej. alerts.low_remaining_contract_credit_and_commit_balance_reached: remaining_balance y threshold en la
    // unidad del tipo de crédito (EUR = unidades enteras; USD = céntimos → METRONOME_AMOUNT_SCALE=100).
    const scale = Number(process.env.METRONOME_AMOUNT_SCALE || 1) || 1;
    const remaining = typeof p.remaining_balance === "number" ? p.remaining_balance / scale : null;
    const zero = remaining !== null && remaining <= 0;
    const msg = zero
      ? "Metronome avisa: saldo agotado."
      : `Metronome avisa: ${p.alert_name ?? "saldo bajo"}${remaining !== null ? ` (quedan ${eur(remaining)})` : ""}.`;
    return { status: push(zero ? "zero_balance" : "low_balance", msg) ? "stored" : "unknown_customer" } as const;
  }
  if (ev.type === "payment_gate.payment_status") {
    const paid = p.payment_status === "paid";
    if (paid && p.workflow_type === "manual_commit" && typeof p.contract_id === "string" && opts.onPaymentPaid) {
      // TODO(verificar): correlacionar por invoice_id con el commit concreto si hay varias compras a la vez.
      await opts.onPaymentPaid(p.contract_id);
    }
    push("payment", paid ? "Pago confirmado en Stripe. Saldo liberado." : `El pago ha fallado: ${p.error_message ?? "motivo desconocido"}.`);
    return { status: "stored" } as const;
  }
  if (ev.type === "payment_gate.payment_pending_action_required") {
    push("payment", "El pago necesita una acción adicional (p. ej. 3D Secure).");
    return { status: "stored" } as const;
  }
  return { status: "ignored", reason: `tipo no gestionado: ${ev.type}` } as const;
}
