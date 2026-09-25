// Verificación y procesado de webhooks de Metronome.
// Firma (https://docs.metronome.com/guides/platform-configuration/setup-webhooks#verify-signatures):
//   HMAC_SHA256(secret, X-Metronome-Date + "\n" + cuerpo_en_bruto) en hexadecimal == Metronome-Webhook-Signature
//   Se prefiere X-Metronome-Date (los proxies pueden reescribir Date). Ignorar > 5 min; deduplicar por id (persistido).
// Interpretación: interpretWebhook (port del helper del setup) → acción de negocio → efectos en la cuenta simulada
// o en el enlace del cliente real.
import { createHmac, timingSafeEqual } from "node:crypto";
import { eur } from "./catalog";
import { nowIso } from "./clock";
import { addAlert, findLinkByMetronomeId, getAccount, isWebhookSeen, markWebhookSeen } from "./store";
import type { Alert } from "./billing/types";
import type { MetronomeWebhookEvent } from "./billing/metronome-types";
import { interpretWebhook } from "./billing/metronome-helpers";
import { confirmBundlePaymentsMock, setAccessCutMock } from "./billing/mock";

type HeaderGetter = { get(name: string): string | null };

export function signMetronome(secret: string, date: string, rawBody: string) {
  return createHmac("sha256", secret).update(`${date}\n${rawBody}`).digest("hex");
}

export function verifyMetronomeSignature(rawBody: string, headers: HeaderGetter, secret: string, opts: { now?: number; toleranceMs?: number } = {}): { ok: true } | { ok: false; reason: string } {
  const date = headers.get("x-metronome-date") ?? headers.get("date");
  const sig = headers.get("metronome-webhook-signature");
  if (!date || !sig) return { ok: false, reason: "Missing X-Metronome-Date/Date or Metronome-Webhook-Signature headers" };
  const ts = new Date(date).valueOf();
  if (Number.isNaN(ts)) return { ok: false, reason: "Invalid date header" };
  const tol = opts.toleranceMs ?? 5 * 60 * 1000;
  const now = opts.now ?? Date.now();
  if (tol > 0 && Math.abs(now - ts) > tol) return { ok: false, reason: "Notification outside the 5-minute window" };
  const expected = Buffer.from(signMetronome(secret, date, rawBody));
  const got = Buffer.from(sig.trim());
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, reason: "Invalid signature" };
  return { ok: true };
}

export type MetronomeEvent = MetronomeWebhookEvent;

/** A qué cliente pertenece: cuenta simulada (id local) o cliente real (id de Metronome enlazado). */
function target(customerId: string | undefined): { kind: "mock" | "live"; key: string } | null {
  if (!customerId) return null;
  if (getAccount(customerId)) return { kind: "mock", key: customerId };
  if (findLinkByMetronomeId(customerId)) return { kind: "live", key: customerId };
  return null;
}

type Result = { status: "stored" | "duplicate" | "ignored" | "unknown_customer"; action?: string; reason?: string; purchases?: string[] };

export async function handleMetronomeEvent(ev: MetronomeEvent, opts: { verified: boolean; source?: Alert["source"] }): Promise<Result> {
  if (!ev?.id || !ev?.type) return { status: "ignored", reason: "event without id/type" };
  if (isWebhookSeen(ev.id)) return { status: "duplicate" };
  const scale = Number(process.env.METRONOME_AMOUNT_SCALE || 1) || 1;
  const act = interpretWebhook(ev, scale);
  if (act.action === "ignore") { markWebhookSeen(ev.id); return { status: "ignored", reason: `unhandled type: ${ev.type}` }; }

  const t = target(act.customerId);
  if (!t) { markWebhookSeen(ev.id); return { status: "unknown_customer", action: act.action }; }
  const ts = (ev.properties?.timestamp as string | undefined) ?? nowIso();
  const push = (type: Alert["type"], message: string) =>
    addAlert(t.key, { id: `wh_${ev.id}`, ts, type, message, source: opts.source ?? "webhook", verified: opts.verified });
  // Carga perezosa del adaptador en vivo (evita cargar el SDK en modo simulado).
  const live = t.kind === "live" ? await import("./billing/metronome") : null;
  const setCut = (cut: boolean) => (t.kind === "mock" ? setAccessCutMock(t.key, cut) : live!.setAccessCutLive(t.key, cut));
  let purchases: string[] | undefined;

  switch (act.action) {
    case "offer_top_up":
      push("low_balance", `Metronome alert: low balance (${eur(act.remainingEur)} left). Want to top up?`);
      break;
    case "cut_access":
      // Alerta global de 0 €: la app corta en Free/Pro (Metronome no bloquea el uso). Scale sigue con overage.
      setCut(true);
      push("zero_balance", "Metronome alert: balance used up. On Free/Pro, access is paused until you top up.");
      break;
    case "payment_succeeded":
      if (act.workflowType === "spend") push("payment", "Early spend-threshold charge confirmed.");
      else {
        purchases = t.kind === "mock" ? confirmBundlePaymentsMock(t.key, true) : await live!.confirmBundlePaymentsLive(t.key, true);
        push("payment", purchases.length ? "Payment confirmed in Stripe: bundle balance and gift available." : "Payment confirmed in Stripe. Balance released.");
      }
      setCut(false);
      break;
    case "payment_failed":
      if (act.workflowType === "spend") {
        // Si falla el cobro de umbral, Metronome desactiva el spend threshold: cortamos y avisamos.
        setCut(true);
        push("payment", `The early threshold charge failed${act.message ? `: ${act.message}` : ""}. Please check your card.`);
      } else {
        purchases = t.kind === "mock" ? confirmBundlePaymentsMock(t.key, false) : await live!.confirmBundlePaymentsLive(t.key, false);
        push("payment", `The payment failed${act.message ? `: ${act.message}` : ""}. No balance was added.`);
      }
      break;
    case "payment_requires_action":
      push("payment", "The payment needs an extra step (e.g. 3D Secure) in Stripe.");
      break;
    case "threshold_charge_started":
      push("payment", act.workflowType === "spend"
        ? "You reached the spend threshold: an early charge has started."
        : "Your balance dropped below the threshold: auto-recharge has started.");
      break;
  }
  markWebhookSeen(ev.id); // solo tras procesar bien: si algo lanza, el reintento de Metronome lo vuelve a procesar
  return { status: "stored", action: act.action, purchases };
}
