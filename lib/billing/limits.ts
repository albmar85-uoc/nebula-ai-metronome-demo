// Límite de gasto mensual fijado por el cliente. Es una regla de la APP (Metronome no bloquea peticiones):
// se aplica antes de aceptar cada petición y responde 402 si la petición haría superar el límite.
// Gasto del periodo = coste del uso del periodo con el descuento del plan (lo que ves en "Gastado este mes"),
// se cubra con créditos o no. El aviso del 80 % y el del 100 % se emiten una vez por periodo.
import { METRICS, type MetricId } from "../catalog";
import { round2 } from "./insights";
import type { DailyUsage, SpendCap, UsageRequest } from "./types";

export const CAP_ALERT_RATIO = 0.8;
export const CAP_MIN_EUR = 1;
export const CAP_MAX_EUR = 100_000;

export const periodSpend = (daily: DailyUsage[] | undefined, periodStart: string) =>
  round2((daily ?? []).filter(d => d.day >= periodStart.slice(0, 10)).reduce((s, d) => s + d.cost, 0));

/** Coste (con descuento) de una petición antes de aceptarla. */
export function requestCost(r: UsageRequest, discount: number) {
  const parts: [MetricId, number][] = [["input_tokens", r.inputTokens ?? 0], ["output_tokens", r.outputTokens ?? 0], ["images", r.images ?? 0]];
  return parts.reduce((s, [m, q]) => s + (q > 0 ? METRICS[m].pricePerUnit * q * (1 - discount) : 0), 0);
}

/** Worst-case cost of a request: known input tokens and images, output tokens capped by max_tokens (maxOutputTokens). */
export function maxRequestCost(r: UsageRequest, discount: number) {
  return requestCost({ ...r, outputTokens: Math.max(r.outputTokens ?? 0, r.maxOutputTokens ?? 0) }, discount);
}

/**
 * Prepaid-only plans (Free, and Pro without auto-recharge) must never go below €0, so they never bill overage: a request is
 * accepted only if the remaining balance covers its worst-case cost. Plans with overage (Scale) or auto-recharge on
 * always pass (the top-up / month-end invoice covers the excess).
 */
export function coversWorstCase(p: { overage: boolean; autoRecharge?: boolean }, balanceEur: number, r: UsageRequest, discount: number) {
  if (p.overage || p.autoRecharge) return true;
  return maxRequestCost(r, discount) <= balanceEur + 1e-9;
}

/** true si la petición cabe en el límite (sin límite siempre cabe). */
export const fitsCap = (cap: SpendCap | undefined, spent: number, cost: number) => !cap || spent + cost <= cap.monthlyEur + 1e-9;

/** Avisos a emitir tras actualizar el gasto. Muta las marcas de la cap (una vez por periodo). */
export function capAlerts(cap: SpendCap | undefined, spent: number, periodStart: string): ("80" | "100")[] {
  if (!cap) return [];
  const out: ("80" | "100")[] = [];
  if (spent >= cap.monthlyEur * CAP_ALERT_RATIO && cap.alerted80At !== periodStart) { cap.alerted80At = periodStart; out.push("80"); }
  if (spent >= cap.monthlyEur - 0.005 && cap.alerted100At !== periodStart) { cap.alerted100At = periodStart; out.push("100"); }
  return out;
}

/** Nuevo límite validado; conserva las marcas de aviso solo si el gasto ya las superaba con el nuevo importe. */
export function normalizeCap(monthlyEur: number | null, spent: number, prev?: SpendCap): SpendCap | undefined {
  if (monthlyEur === null) return undefined;
  if (!Number.isFinite(monthlyEur) || monthlyEur < CAP_MIN_EUR || monthlyEur > CAP_MAX_EUR) throw new Error(`The limit must be between €${CAP_MIN_EUR} and €${CAP_MAX_EUR.toLocaleString("en-US")}`);
  const cap: SpendCap = { monthlyEur: round2(monthlyEur) };
  if (prev?.alerted80At && spent >= cap.monthlyEur * CAP_ALERT_RATIO) cap.alerted80At = prev.alerted80At;
  if (prev?.alerted100At && spent >= cap.monthlyEur) cap.alerted100At = prev.alerted100At;
  return cap;
}

export const capMessage = (kind: "80" | "100", cap: SpendCap, spent: number, eur: (n: number) => string) =>
  kind === "80"
    ? `You've spent ${eur(spent)} this month: 80% of your ${eur(cap.monthlyEur)} limit. Once you reach it, the API will reject requests (402).`
    : `You've reached your monthly spend limit (${eur(cap.monthlyEur)}). The API rejects new requests until the next period or until you raise the limit.`;
