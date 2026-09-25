import { randomUUID } from "node:crypto";
import { PLANS, eur, type MetricId } from "./catalog";
import { nowIso, nowMs } from "./clock";
import { balance, closePeriods, mockBilling, seedHistoryMock, usageCost } from "./billing/mock";
import { round2 } from "./billing/insights";
import type { Account, Alert, DailyUsage, UsageRequest } from "./billing/types";
import { PERSONAS, PERSONA_IDS, type PersonaId } from "./personas";
import { addEnterpriseLead, getAccount, getDemoState, resetAll, saveAccount, setDemoState } from "./store";

// Demo controls (mock mode only): seeded personas, fast-forward to month end, traffic spike, reset.
// Everything goes through the same mock billing engine the app uses, so each control shows real behavior:
// month close = Metronome's end-of-period invoice + credit expiry + new recurring credits; spike = spend_threshold_configuration.

const DAY = 86_400_000;
const alert = (a: Account, type: Alert["type"], message: string) =>
  a.alerts.unshift({ id: `al_${randomUUID().slice(0, 8)}`, ts: nowIso(), type, message, source: "local" });

/** A text request with a fixed list price (€). Output = input/4, so list = 2·in/1M + 8·out/1M = 4·in/1M ⇒ in = list × 250k. */
function textRequest(listEur: number, requestId: string, ts?: string): UsageRequest {
  return { requestId, inputTokens: Math.round(listEur * 250_000), outputTokens: Math.round(listEur * 62_500), ts, source: "simulator" };
}

/** Spreads `n` timestamps between the period start and now (all "now" right after a period change). */
function spread(a: Account, n: number) {
  const start = +new Date(a.periodStart) + 3600_000, end = nowMs() - 600_000;
  return Array.from({ length: n }, (_, i) => new Date(end <= start ? nowMs() : start + ((end - start) * i) / Math.max(1, n - 1)).toISOString());
}

/** 30 days of daily history before the current period (chart + recommender), roughly `dailyListEur` per day. */
function history(a: Account, dailyListEur: number, imagesPerDay: number) {
  const rows: DailyUsage[] = [];
  const disc = PLANS[a.plan].discount;
  for (let i = 30; i >= 1; i--) {
    const d = new Date(nowMs() - i * DAY);
    if (+d >= +new Date(a.periodStart)) continue;
    const jitter = 0.75 + ((i * 37) % 50) / 100;
    const list = dailyListEur * jitter;
    const q: [MetricId, number][] = [["input_tokens", Math.round(list * 250_000)], ["output_tokens", Math.round(list * 62_500)], ["images", Math.round(imagesPerDay * jitter)]];
    for (const [metric, quantity] of q) if (quantity) rows.push({ day: d.toISOString().slice(0, 10), metric, quantity, cost: usageCost(metric, quantity, disc) });
  }
  if (rows.length) seedHistoryMock(a.customerId, rows);
}

/** Makes a fresh sign-up look like a long-standing customer: full plan credits for the period, no sign-up proration noise. */
function asExistingCustomer(customerId: string) {
  const a = getAccount(customerId)!;
  const p = PLANS[a.plan];
  const rc = a.credits.find(c => c.kind === "recurring");
  if (rc) { rc.amount = p.monthlyCredits; rc.remaining = p.monthlyCredits; rc.label = `${p.name} monthly credits`; }
  a.invoices = a.invoices.filter(i => i.type !== "proration" && i.type !== "subscription");
  if (p.monthlyFee > 0) a.invoices.unshift({
    id: `in_${randomUUID().slice(0, 8)}`, date: a.periodStart, description: `${p.name} monthly fee`, amount: p.monthlyFee, status: "paid", type: "subscription",
    periodStart: a.periodStart, periodEnd: a.periodEnd,
    lines: [{ description: `${p.name} subscription`, quantity: 1, unitPrice: p.monthlyFee, amount: p.monthlyFee, kind: "fee" }],
  } as Account["invoices"][number]);
  a.alerts = [];
  saveAccount(a);
}

/** Current-period usage worth `targetEur` after the plan discount, as individual requests with request ids. */
async function usage(customerId: string, targetEur: number, perRequestList: number, images = 0) {
  const a = getAccount(customerId)!;
  const perReq = perRequestList * (1 - PLANS[a.plan].discount);
  const n = Math.max(1, Math.round(targetEur / perReq));
  const ts = spread(a, n);
  const reqs = ts.map((t, i) => textRequest(perRequestList, `seed-${customerId}-${i}`, t));
  if (images) reqs.push({ requestId: `seed-${customerId}-img`, images, ts: ts[ts.length - 1], source: "simulator" });
  await mockBilling.ingest(customerId, reqs);
}

async function seedPersona(id: PersonaId): Promise<string> {
  const p = PERSONAS[id];
  const acc = await mockBilling.signup({ name: p.name, email: p.email, plan: p.plan });
  const cid = acc.customerId;
  asExistingCustomer(cid);
  switch (id) {
    case "free": // €5 credits → ~€4.30 used: below the 20% low-balance threshold (€1)
      history(getAccount(cid)!, 0.12, 0);
      await usage(cid, 4.3, 0.25);
      break;
    case "pro": // auto-recharge on; ~€41 used ⇒ one top-up to €50 already happened
      await mockBilling.setAutoRecharge(cid, true);
      history(getAccount(cid)!, 1.6, 2);
      await usage(cid, 41, 1, 12);
      break;
    case "scale": // €250 credits used + ~€235 overage (below the €300 early-charge threshold)
      history(getAccount(cid)!, 18, 25);
      await usage(cid, 485, 8, 60);
      break;
    case "enterprise": // heavy Scale usage ⇒ recommender hints Enterprise; early charges already happened
      history(getAccount(cid)!, 75, 120);
      await usage(cid, 1450, 20, 400);
      addEnterpriseLead({ id: `lead_${randomUUID().slice(0, 8)}`, ts: nowIso(), company: p.company, email: p.email, monthlySpend: 2000 });
      break;
  }
  const a = getAccount(cid)!;
  a.alerts = a.alerts.slice(0, 6);
  alert(a, "info", `Demo persona loaded: ${p.name} (${p.company}), ${PLANS[a.plan].name} plan.`);
  saveAccount(a);
  setDemoState(d => { d.personas[id] = cid; });
  return cid;
}

/** Customer id for a persona; seeds it if missing (e.g. after a reset). */
export async function personaAccount(id: PersonaId) {
  if (!PERSONAS[id]) throw new Error("Unknown persona");
  const existing = getDemoState().personas[id];
  if (existing && getAccount(existing)) return existing;
  return seedPersona(id);
}

/** Wipes all demo data (accounts, keys, history, clock) and seeds the four personas again. */
export async function resetDemo() {
  resetAll();
  for (const id of PERSONA_IDS) await seedPersona(id);
  return getDemoState();
}

/**
 * Moves the demo clock to the end of the current billing period and runs the month close for this customer:
 * overage invoice (net of early charges), unused plan credits expire, next month's fee and recurring credits.
 * Other accounts close lazily the next time they are read (same clock).
 */
export function fastForward(customerId: string) {
  const before = getAccount(customerId);
  if (!before) throw new Error("Customer not found");
  closePeriods(before); // in case the clock already passed
  const expiring = round2(before.credits.filter(c => c.kind === "recurring").reduce((s, c) => s + c.remaining, 0));
  const overage = round2(before.overageAccrued - (before.spendPrepaid ?? 0));
  const closedStart = before.periodStart, closedEnd = before.periodEnd;
  const knownInvoices = new Set(before.invoices.map(i => i.id));
  const target = +new Date(closedEnd) + 60_000;
  setDemoState(d => { d.clockOffsetMs += Math.max(0, target - nowMs()); });
  const a = before; // the store hands out the live object; close it at the new (demo) time
  closePeriods(a);
  const created = a.invoices.filter(i => !knownInvoices.has(i.id));
  const p = PLANS[a.plan];
  const fmt = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const parts = [
    overage > 0 ? `overage invoice ${eur(overage)}` : "no overage",
    expiring > 0 ? `${eur(expiring)} of unused plan credits expired` : null,
    `${eur(p.monthlyCredits)} of new ${p.name} credits`,
    p.monthlyFee > 0 ? `${p.name} fee ${eur(p.monthlyFee)}` : null,
  ].filter(Boolean);
  const summary = `Month closed (${fmt(closedStart)} – ${fmt(new Date(+new Date(closedEnd) - DAY).toISOString())}): ${parts.join(" · ")}.`;
  alert(a, "info", summary);
  saveAccount(a);
  return { summary, invoices: created.map(i => ({ id: i.id, description: i.description, amount: i.amount })), periodStart: a.periodStart, periodEnd: a.periodEnd, balance: balance(a) };
}

/**
 * Traffic spike: a burst of large requests. On Scale it is sized to push overage past the next €300 step, so the
 * spend threshold fires an early charge (payment_gate.threshold_reached in live). On Free it hits €0 (cut-off); on Pro
 * it triggers auto-recharge (or the cut-off if auto-recharge is off).
 */
export async function trafficSpike(customerId: string) {
  const a = getAccount(customerId);
  if (!a) throw new Error("Customer not found");
  closePeriods(a); saveAccount(a);
  const plan = PLANS[a.plan];
  const perList = a.plan === "scale" ? 20 : a.plan === "pro" ? 2 : 0.25;
  const perCost = perList * (1 - plan.discount);
  let need: number;
  if (a.plan === "scale") {
    const step = a.spendThreshold?.enabled ? a.spendThreshold.thresholdEur : 300;
    need = Math.max(0, balance(a)) + Math.max(0, (a.spendPrepaid ?? 0) + step - a.overageAccrued) + 25;
  } else if (a.plan === "pro") need = Math.max(balance(a) - 8, 6);
  else need = Math.max(balance(a) + 0.5, 1);
  const n = Math.min(400, Math.ceil(need / perCost));
  const tag = Date.now().toString(36);
  const reqs = Array.from({ length: n }, (_, i) => textRequest(perList, `spike-${tag}-${i}`));
  const invoicesBefore = new Set(a.invoices.map(i => i.id));
  const r = await mockBilling.ingest(customerId, reqs);
  const after = r.account;
  const early = after.invoices.filter(i => !invoicesBefore.has(i.id) && i.type === "threshold");
  const recharge = after.invoices.filter(i => !invoicesBefore.has(i.id) && i.type === "commit");
  const cost = round2(r.accepted.length * perCost);
  const outcome = early.length ? `early charge of ${eur(early.reduce((s, i) => s + i.amount, 0))} (spend threshold)`
    : recharge.length ? `auto-recharge charged ${eur(recharge.reduce((s, i) => s + i.amount, 0))}`
    : r.rejected ? (r.reason === "spend_cap" ? "stopped by the monthly spend limit (402)" : r.reason === "insufficient_balance" ? "stopped: the remaining balance can't cover the next request, never goes below €0 (402)" : "balance used up, API access paused (402)")
    : "absorbed by the balance";
  return { summary: `Traffic spike: ${r.accepted.length} requests (${eur(cost)}) → ${outcome}.`, accepted: r.accepted.length, rejected: r.rejected, reason: r.reason, earlyCharges: early.length };
}

export const demoClock = () => ({ offsetMs: getDemoState().clockOffsetMs, now: nowIso() });
