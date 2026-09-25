// Verificación y procesado de webhooks de Metronome.
// Firma (https://docs.metronome.com/guides/platform-configuration/setup-webhooks#verify-signatures):
//   HMAC_SHA256(secret, X-Metronome-Date + "\n" + cuerpo_en_bruto) en hexadecimal == Metronome-Webhook-Signature
//   Se prefiere X-Metronome-Date (los proxies pueden reescribir Date). Ignorar > 5 min; deduplicar por id (persistido).
// Interpretación: interpretWebhook (port del helper del setup) → acción de negocio → efectos en la cuenta simulada
// o en el enlace del cliente real.
import { createHmac, timingSafeEqual } from "node:crypto";
import { eur } from "./catalog";
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
  if (!ev?.id || !ev?.type) return { status: "ignored", reason: "evento sin id/type" };
  if (isWebhookSeen(ev.id)) return { status: "duplicate" };
  const scale = Number(process.env.METRONOME_AMOUNT_SCALE || 1) || 1;
  const act = interpretWebhook(ev, scale);
  if (act.action === "ignore") { markWebhookSeen(ev.id); return { status: "ignored", reason: `tipo no gestionado: ${ev.type}` }; }

  const t = target(act.customerId);
  if (!t) { markWebhookSeen(ev.id); return { status: "unknown_customer", action: act.action }; }
  const ts = (ev.properties?.timestamp as string | undefined) ?? new Date().toISOString();
  const push = (type: Alert["type"], message: string) =>
    addAlert(t.key, { id: `wh_${ev.id}`, ts, type, message, source: opts.source ?? "webhook", verified: opts.verified });
  // Carga perezosa del adaptador en vivo (evita cargar el SDK en modo simulado).
  const live = t.kind === "live" ? await import("./billing/metronome") : null;
  const setCut = (cut: boolean) => (t.kind === "mock" ? setAccessCutMock(t.key, cut) : live!.setAccessCutLive(t.key, cut));
  let purchases: string[] | undefined;

  switch (act.action) {
    case "offer_top_up":
      push("low_balance", `Metronome avisa: saldo bajo (quedan ${eur(act.remainingEur)}). ¿Quieres recargar?`);
      break;
    case "cut_access":
      // Alerta global de 0 €: la app corta en Free/Pro (Metronome no bloquea el uso). Scale sigue con overage.
      setCut(true);
      push("zero_balance", "Metronome avisa: saldo agotado. En Free/Pro el acceso queda en pausa hasta que recargues.");
      break;
    case "payment_succeeded":
      if (act.workflowType === "spend") push("payment", "Cobro anticipado por umbral de gasto confirmado.");
      else {
        purchases = t.kind === "mock" ? confirmBundlePaymentsMock(t.key, true) : await live!.confirmBundlePaymentsLive(t.key, true);
        push("payment", purchases.length ? "Pago confirmado en Stripe: saldo y regalo del bundle disponibles." : "Pago confirmado en Stripe. Saldo liberado.");
      }
      setCut(false);
      break;
    case "payment_failed":
      if (act.workflowType === "spend") {
        // Si falla el cobro de umbral, Metronome desactiva el spend threshold: cortamos y avisamos.
        setCut(true);
        push("payment", `El cobro anticipado por umbral ha fallado${act.message ? `: ${act.message}` : ""}. Revisa tu tarjeta.`);
      } else {
        purchases = t.kind === "mock" ? confirmBundlePaymentsMock(t.key, false) : await live!.confirmBundlePaymentsLive(t.key, false);
        push("payment", `El pago ha fallado${act.message ? `: ${act.message}` : ""}. No se ha añadido saldo.`);
      }
      break;
    case "payment_requires_action":
      push("payment", "El pago necesita una acción adicional (p. ej. 3D Secure) en Stripe.");
      break;
    case "threshold_charge_started":
      push("payment", act.workflowType === "spend"
        ? "Has alcanzado el umbral de gasto: se ha iniciado un cobro anticipado."
        : "Tu saldo bajó del umbral: se ha iniciado la recarga automática.");
      break;
  }
  markWebhookSeen(ev.id); // solo tras procesar bien: si algo lanza, el reintento de Metronome lo vuelve a procesar
  return { status: "stored", action: act.action, purchases };
}
