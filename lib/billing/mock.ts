// Simulación del comportamiento de Metronome + Stripe, persistida en ./data/db.json.
// Reproduce lo que hace el setup del experto (/workspace/metronome-setup):
//  - contrato con cuota ADVANCE, crédito recurrente mensual (caduca cada periodo) y descuento por plan;
//  - cambio de plan como "contract transition": subida inmediata y prorrateada con rollover del saldo,
//    bajada programada al inicio del siguiente periodo (commits, regalos y promos se conservan);
//  - bundles = commit con payment gate; el regalo se concede solo tras el webhook payment_gate.payment_status=paid;
//  - recarga automática "hasta 50 €" (Free/Pro/Scale), cobro anticipado por umbral de gasto (Scale), promos con caducidad;
//  - alertas del 20 % (por plan) y de 0 €, corte de acceso en Free/Pro; ingesta idempotente por id de petición.
import { AUTO_RECHARGE, BUNDLES, LOW_BALANCE_RATIO, METRICS, PLANS, PROMOTIONS, SPEND_THRESHOLD, eur, type BundleId, type MetricId, type PlanId } from "../catalog";
import { addPurchase, getAccount, getAlerts, getPurchase, pendingPurchases, resolvePurchase, saveAccount } from "../store";
import { recommendPlan, round2, usageLast30DaysFromDaily } from "./insights";
import type { InvoiceLineView, UpcomingInvoicePreview } from "./metronome-types";
import type { Account, Alert, BillingProvider, CreditGrant, DailyUsage, Invoice, InvoiceLine, UsageRequest } from "./types";

const id = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const nowIso = () => new Date().toISOString();
export const round = (n: number) => Math.round(n * 10000) / 10000;
const addMonths = (iso: string, m: number) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString(); };
const addDays = (iso: string, n: number) => { const d = new Date(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString(); };
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("es-ES", { timeZone: "UTC" });

export const balance = (a: Pick<Account, "credits">) => round(a.credits.reduce((s, c) => s + c.remaining, 0));

/** Periodo de facturación = mes natural en UTC. */
export function monthBounds(d = new Date()) {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start, end };
}

/** Fracción del periodo que queda por consumir (para el prorrateo). */
export function remainingRatio(a: Pick<Account, "periodStart" | "periodEnd">, at = Date.now()) {
  const start = +new Date(a.periodStart), end = +new Date(a.periodEnd);
  return Math.min(1, Math.max(0, (end - at) / (end - start)));
}

function pushAlert(a: Account, type: Alert["type"], message: string) {
  a.alerts.unshift({ id: id("al"), ts: nowIso(), type, message, source: "local" });
  a.alerts = a.alerts.slice(0, 30);
}

function charge(a: Account, description: string, amount: number, type: Invoice["type"], lines?: InvoiceLine[], extra: Partial<Invoice> = {}) {
  // En producción: Metronome emite la factura y la cobra en Stripe sobre la tarjeta guardada.
  if (amount <= 0) return undefined;
  const inv: Invoice = {
    id: id("in"), date: nowIso(), description, amount: round(amount), status: "paid", type,
    lines: lines ?? [{ description, quantity: 1, unitPrice: round(amount), amount: round(amount) }],
    externalId: `pi_sim_${Math.random().toString(36).slice(2, 12)}`, ...extra,
  };
  a.invoices.unshift(inv);
  return inv;
}

const recurringCredit = (plan: PlanId, amount: number, periodEnd: string, label?: string): CreditGrant => ({
  id: id("rc"), kind: "recurring", label: label ?? `Créditos mensuales ${PLANS[plan].name}`, amount, remaining: amount, createdAt: nowIso(), expiresAt: periodEnd,
});

/** Aviso del 20 %: importe fijo por plan (20 % del crédito mensual), como syncPlanLowBalanceAlert del setup. */
export const lowBalanceLimit = (a: Pick<Account, "plan">) => round2(PLANS[a.plan].monthlyCredits * LOW_BALANCE_RATIO);

/** Recalcula el bloqueo: Free/Pro se cortan con saldo 0 o si un webhook cortó el acceso. Scale nunca (overage). */
function refreshBlocked(a: Account) {
  const p = PLANS[a.plan];
  a.blocked = !p.overage && (balance(a) <= 0 || !!a.accessCut);
}

function autoRecharge(a: Account) {
  const bal = balance(a);
  const amount = round2(AUTO_RECHARGE.rechargeTo - Math.max(0, bal));
  const inv = charge(a, `Recarga automática hasta ${eur(AUTO_RECHARGE.rechargeTo)}`, amount, "commit", [
    { description: `Commit prepagado (recarga automática: saldo ${eur(bal)} → ${eur(AUTO_RECHARGE.rechargeTo)})`, quantity: 1, unitPrice: amount, amount, kind: "commit" },
  ]);
  a.credits.push({ id: id("ar"), kind: "commit", label: "Recarga automática", amount, remaining: amount, createdAt: nowIso(), expiresAt: addMonths(nowIso(), AUTO_RECHARGE.validityMonths), reference: inv?.id });
  a.accessCut = false;
  pushAlert(a, "auto_recharge", `El saldo bajó de ${eur(AUTO_RECHARGE.threshold)}: se cobraron ${eur(amount)} y el saldo vuelve a ${eur(AUTO_RECHARGE.rechargeTo)}.`);
}

function spendThresholdCheck(a: Account) {
  const st = a.spendThreshold;
  if (!st?.enabled || a.plan !== "scale") return;
  while (a.overageAccrued - (a.spendPrepaid ?? 0) >= st.thresholdEur) {
    a.spendPrepaid = round((a.spendPrepaid ?? 0) + st.thresholdEur);
    charge(a, `Cobro anticipado: el gasto extra alcanzó ${eur(st.thresholdEur)}`, st.thresholdEur, "threshold", [
      { description: `Spend threshold (${eur(st.thresholdEur)}) · se descontará de la factura de uso del periodo`, quantity: 1, unitPrice: st.thresholdEur, amount: st.thresholdEur, kind: "commit" },
    ], { periodStart: a.periodStart, periodEnd: a.periodEnd });
    // En vivo llegan payment_gate.threshold_reached y payment_gate.payment_status (workflow_type "spend").
    pushAlert(a, "payment", `Pico de uso: tu gasto extra llegó a ${eur(st.thresholdEur)} y lo hemos cobrado por adelantado.`);
  }
}

function evaluate(a: Account, prevBalance: number) {
  const bal = balance(a);
  const plan = PLANS[a.plan];
  if (a.autoRecharge && plan.autoRechargeAllowed && bal < AUTO_RECHARGE.threshold) { autoRecharge(a); refreshBlocked(a); return; }
  const lim = lowBalanceLimit(a);
  if (prevBalance >= lim && bal < lim && bal > 0) pushAlert(a, "low_balance", `Te queda menos del 20 % de tus créditos del plan (${eur(bal)}). ¿Quieres recargar?`);
  if (bal <= 0 && prevBalance > 0) {
    if (plan.overage) pushAlert(a, "zero_balance", "Saldo agotado. El uso extra se facturará a fin de mes.");
    else pushAlert(a, "zero_balance", "Saldo agotado. El acceso a la API se ha pausado hasta que recargues o subas de plan.");
  }
  spendThresholdCheck(a);
  refreshBlocked(a);
}

/** Orden de consumo = prioridad en Metronome: plan (1) → promo (3) → regalo del bundle (5) → commits pagados (10). */
export const DEDUCTION_ORDER: CreditGrant["kind"][] = ["recurring", "promo", "gift", "commit"];
export function deduct(a: Pick<Account, "credits">, cost: number): number {
  let left = cost;
  for (const k of DEDUCTION_ORDER) {
    // Dentro de la misma prioridad, primero lo que caduca antes.
    const grants = a.credits.filter(x => x.kind === k).sort((x, y) => (x.expiresAt ?? "9999").localeCompare(y.expiresAt ?? "9999"));
    for (const c of grants) {
      if (left <= 0) break;
      const take = Math.min(c.remaining, left);
      c.remaining = round(c.remaining - take);
      left = round(left - take);
    }
  }
  return left; // lo que no cubre el saldo
}

export const usageCost = (metric: MetricId, quantity: number, discount: number) => round(METRICS[metric].pricePerUnit * quantity * (1 - discount));

function addDaily(a: Account, ts: string, metric: MetricId, quantity: number, cost: number) {
  const day = ts.slice(0, 10);
  const daily = (a.daily ??= []);
  let row = daily.find(d => d.day === day && d.metric === metric);
  if (!row) { row = { day, metric, quantity: 0, cost: 0 }; daily.push(row); }
  row.quantity += quantity;
  row.cost = round(row.cost + cost);
  a.daily = daily.sort((x, y) => x.day.localeCompare(y.day)).slice(-3 * 120);
}

/** Cierre de periodo(s): factura el exceso, caducan créditos del plan, se aplica la bajada programada y se cobra la nueva cuota. */
export function closePeriods(a: Account, at = Date.now()): boolean {
  let changed = false;
  // Caducidad de promos/commits a mitad de periodo
  for (const c of a.credits) if (c.expiresAt && +new Date(c.expiresAt) <= at && c.remaining > 0 && c.kind !== "recurring") { c.remaining = 0; changed = true; }
  let guard = 0;
  while (at >= +new Date(a.periodEnd) && guard++ < 24) {
    changed = true;
    const closedStart = a.periodStart, closedEnd = a.periodEnd;
    const due = round(a.overageAccrued - (a.spendPrepaid ?? 0));
    if (a.overageAccrued > 0) {
      charge(a, `Uso extra del periodo ${fmtDay(closedStart)} – ${fmtDay(addDays(closedEnd, -1))}`, Math.max(0, due), "usage", [
        { description: "Uso no cubierto por créditos", amount: a.overageAccrued, kind: "usage" },
        ...(a.spendPrepaid ? [{ description: "Cobros anticipados por umbral ya pagados", amount: -a.spendPrepaid, kind: "credit" as const }] : []),
      ], { date: closedEnd, periodStart: closedStart, periodEnd: closedEnd });
    }
    a.overageAccrued = 0;
    a.spendPrepaid = 0;
    // Los créditos del plan caducan cada periodo; commits/regalos/promos solo por su propia fecha.
    a.credits = a.credits.filter(c => c.kind !== "recurring" && !(c.expiresAt && c.expiresAt <= closedEnd) && !(c.remaining <= 0 && c.kind !== "commit"));
    if (a.pendingPlan && a.pendingPlan.effectiveAt <= closedEnd) {
      const to = a.pendingPlan.plan;
      pushAlert(a, "info", `Tu bajada al plan ${PLANS[to].name} ya está activa. Tus bundles, regalos y promociones se mantienen.`);
      a.plan = to;
      a.pendingPlan = undefined;
      if (!PLANS[to].autoRechargeAllowed) a.autoRecharge = false;
      if (to !== "scale") a.spendThreshold = undefined;
    }
    const { start, end } = monthBounds(new Date(closedEnd));
    a.periodStart = start.toISOString();
    a.periodEnd = end.toISOString();
    const p = PLANS[a.plan];
    charge(a, `Cuota mensual ${p.name}`, p.monthlyFee, "subscription", [
      { description: `Suscripción ${p.name} (${fmtDay(a.periodStart)} – ${fmtDay(addDays(a.periodEnd, -1))})`, quantity: 1, unitPrice: p.monthlyFee, amount: p.monthlyFee, kind: "fee" },
    ], { date: a.periodStart, periodStart: a.periodStart, periodEnd: a.periodEnd });
    a.credits.unshift(recurringCredit(a.plan, p.monthlyCredits, a.periodEnd));
    a.accessCut = false;
  }
  if (changed) refreshBlocked(a);
  return changed;
}

/** Factura de uso en borrador del periodo actual (lo que Metronome mostraría como DRAFT). */
export function draftInvoice(a: Account): Invoice {
  const lines: InvoiceLine[] = [];
  let usageTotal = 0;
  for (const m of Object.keys(METRICS) as MetricId[]) {
    const rows = (a.daily ?? []).filter(d => d.metric === m && d.day >= a.periodStart.slice(0, 10));
    const qty = rows.reduce((s, r) => s + r.quantity, 0);
    if (!qty) continue;
    const list = round(METRICS[m].pricePerUnit * qty);
    const net = rows.reduce((s, r) => s + r.cost, 0);
    usageTotal += net;
    lines.push({ description: METRICS[m].name, quantity: qty, unitPrice: METRICS[m].pricePerUnit, amount: list, kind: "usage" });
    if (list - net > 0.00005) lines.push({ description: `Descuento de tu plan · ${METRICS[m].name}`, amount: -round(list - net), kind: "discount" });
  }
  const covered = round(usageTotal - a.overageAccrued);
  if (covered > 0) lines.push({ description: "Créditos y commits aplicados", amount: -covered, kind: "credit" });
  if (a.spendPrepaid) lines.push({ description: "Cobros anticipados por umbral ya pagados", amount: -a.spendPrepaid, kind: "credit" });
  return {
    id: "draft-current", date: nowIso(), description: `Uso del periodo (borrador)`, amount: round(Math.max(0, a.overageAccrued - (a.spendPrepaid ?? 0))), status: "draft", type: "usage",
    periodStart: a.periodStart, periodEnd: a.periodEnd, lines,
  };
}

/** Vista previa de la próxima factura con la forma UpcomingInvoicePreview del setup (en vivo: facturas DRAFT de Metronome). */
export function upcomingInvoice(a: Account): UpcomingInvoicePreview {
  const plan = PLANS[a.plan];
  const lines: InvoiceLineView[] = [];
  let usageNet = 0;
  for (const m of Object.keys(METRICS) as MetricId[]) {
    const rows = (a.daily ?? []).filter(d => d.metric === m && d.day >= a.periodStart.slice(0, 10));
    const qty = rows.reduce((s, r) => s + r.quantity, 0);
    if (!qty) continue;
    const net = round2(rows.reduce((s, r) => s + r.cost, 0));
    usageNet += net;
    lines.push({ name: METRICS[m].name, type: "usage", quantity: qty, unitPriceEur: METRICS[m].pricePerUnit * (1 - plan.discount), totalEur: net, startingAt: a.periodStart, endingBefore: a.periodEnd });
  }
  const covered = round2(usageNet - a.overageAccrued);
  if (covered > 0) lines.push({ name: "Créditos y commits aplicados", type: "applied_commit_or_credit", totalEur: -covered });
  if (a.spendPrepaid) lines.push({ name: "Cobros anticipados por umbral (ya pagados)", type: "applied_commit_or_credit", totalEur: -a.spendPrepaid });
  const nextPlan = PLANS[a.pendingPlan?.plan ?? a.plan];
  if (nextPlan.monthlyFee > 0) {
    lines.push({ name: `Suscripción ${nextPlan.name} · próximo mes (por adelantado)`, type: "subscription", quantity: 1, unitPriceEur: nextPlan.monthlyFee, totalEur: nextPlan.monthlyFee, startingAt: a.periodEnd });
  }
  const gross = round2(usageNet + nextPlan.monthlyFee);
  const applied = round2(Math.max(0, covered) + (a.spendPrepaid ?? 0));
  return {
    customerId: a.customerId, contractId: a.customerId, periodStart: a.periodStart, periodEnd: a.periodEnd,
    grossChargesEur: gross, creditsAppliedEur: applied, totalDueEur: round2(Math.max(0, gross - applied)),
    lines, draftInvoiceIds: ["draft-current"], asOf: nowIso(),
  };
}

/** Añade las vistas calculadas (próxima factura, uso 30 días, recomendación de plan). */
export function withInsights(a: Account, at = new Date()): Account {
  const usage30 = usageLast30DaysFromDaily(a.customerId, a.daily ?? [], at);
  return { ...a, upcoming: a.upcoming ?? upcomingInvoice(a), usage30, recommendation: recommendPlan(usage30, a.plan) };
}

function load(customerId: string): Account {
  const a = getAccount(customerId);
  if (!a) throw new Error("Cliente no encontrado");
  closePeriods(a);
  return a;
}

/** Mezcla las alertas locales con las recibidas por webhook. */
function withWebhookAlerts(a: Account): Account {
  const ext = getAlerts(a.customerId);
  if (!ext.length) return a;
  return { ...a, alerts: [...a.alerts, ...ext].sort((x, y) => y.ts.localeCompare(x.ts)).slice(0, 40) };
}

// ─────────── Acciones disparadas por webhooks (lib/webhooks.ts) sobre cuentas simuladas ───────────

/** Webhook de saldo 0 (alerta global): corta el acceso en Free/Pro. */
export function setAccessCutMock(customerId: string, cut: boolean) {
  const a = getAccount(customerId);
  if (!a) return false;
  a.accessCut = cut && !PLANS[a.plan].overage;
  refreshBlocked(a);
  saveAccount(a);
  return true;
}

/**
 * payment_gate.payment_status (workflow manual_commit) → resuelve las compras pendientes de ESE cliente
 * emparejando por purchaseId: solo se regala el bonus si el commit con esa referencia existe (equivale a findBundleCommit).
 */
export function confirmBundlePaymentsMock(customerId: string, paid: boolean, purchaseId?: string) {
  const a = getAccount(customerId);
  if (!a) return [];
  const done: string[] = [];
  for (const p of pendingPurchases(customerId)) {
    if (purchaseId && p.purchaseId !== purchaseId) continue;
    const commit = a.credits.find(c => c.kind === "commit" && c.reference === p.purchaseId);
    const b = BUNDLES[p.bundle];
    if (paid && commit) {
      const bonus = b.credit - b.price;
      if (bonus > 0 && !a.credits.some(c => c.kind === "gift" && c.reference === p.purchaseId)) {
        a.credits.push({ id: id("gf"), kind: "gift", label: `Regalo del bundle ${eur(b.price)} (+${eur(bonus)})`, amount: bonus, remaining: bonus, createdAt: nowIso(), expiresAt: commit.expiresAt, reference: p.purchaseId });
      }
      resolvePurchase(p.purchaseId, "bonus_granted");
      a.accessCut = false;
      pushAlert(a, "payment", `Pago del bundle confirmado: ${eur(b.price)} + ${eur(bonus)} de regalo disponibles.`);
      done.push(p.purchaseId);
    } else if (!paid) {
      // Metronome no crea el commit si el pago falla (sin reintentos): lo retiramos de la simulación.
      a.credits = a.credits.filter(c => c.reference !== p.purchaseId);
      const inv = a.invoices.find(i => i.externalId === `purchase:${p.purchaseId}`);
      if (inv) inv.status = "void";
      resolvePurchase(p.purchaseId, "failed");
      pushAlert(a, "payment", `El pago del bundle de ${eur(b.price)} ha fallado. No se ha cobrado nada.`);
      done.push(p.purchaseId);
    }
  }
  refreshBlocked(a);
  saveAccount(a);
  return done;
}

/** Histórico previo al periodo actual (solo para la cuenta de demostración: gráfico de 30 días). */
export function seedHistoryMock(customerId: string, rows: DailyUsage[]) {
  const a = load(customerId);
  for (const r of rows) addDaily(a, `${r.day}T12:00:00.000Z`, r.metric, r.quantity, r.cost);
  saveAccount(a);
}

async function simulatePaymentWebhook(customerId: string, purchaseId: string) {
  if (process.env.MOCK_AUTO_PAYMENT_WEBHOOK === "0") return;
  // Pasa por el mismo manejador que los webhooks reales (cuerpo con la forma documentada de payment_gate.payment_status).
  const { handleMetronomeEvent } = await import("../webhooks");
  await handleMetronomeEvent(
    { id: `sim-pay-${purchaseId}`, type: "payment_gate.payment_status", properties: { workflow_type: "manual_commit", customer_id: customerId, contract_id: customerId, payment_status: "paid", invoice_id: `purchase:${purchaseId}` } },
    { verified: false, source: "local" },
  );
}

export const mockBilling: BillingProvider = {
  mode: "mock",
  async signup({ name, email, plan }) {
    const { start, end } = monthBounds();
    const p = PLANS[plan];
    const ratio = remainingRatio({ periodStart: start.toISOString(), periodEnd: end.toISOString() });
    const credits = round2(p.monthlyCredits * ratio); // primer periodo prorrateado (FIRST_AND_LAST), como la suscripción
    const fee = round2(p.monthlyFee * ratio);
    const a: Account = {
      customerId: id("cus"), name, email, plan, cardSaved: true, autoRecharge: false, blocked: false, overageAccrued: 0,
      spendThreshold: plan === "scale" ? { enabled: true, thresholdEur: SPEND_THRESHOLD.scaleThreshold, paymentGate: "STRIPE" } : undefined,
      credits: [recurringCredit(plan, credits, end.toISOString(), `Créditos mensuales ${p.name}${ratio < 0.999 ? " (prorrateados)" : ""}`)],
      usage: [], daily: [], seenRequests: [], redeemedPromos: [], invoices: [], alerts: [], periodStart: start.toISOString(), periodEnd: end.toISOString(), mode: "mock",
    };
    charge(a, `Cuota mensual ${p.name}${ratio < 0.999 ? " (prorrateada)" : ""}`, fee, "subscription", [
      { description: `Suscripción ${p.name} (${fmtDay(nowIso())} – ${fmtDay(addDays(end.toISOString(), -1))}, ${Math.round(ratio * 100)} % del mes)`, quantity: round(ratio), unitPrice: p.monthlyFee, amount: fee, kind: "fee" },
      { description: `Créditos del plan incluidos (${eur(credits)})`, amount: 0, kind: "credit" },
    ], { periodStart: start.toISOString(), periodEnd: end.toISOString() });
    pushAlert(a, "info", `Cuenta creada en el plan ${p.name}. Tarjeta guardada en Stripe.`);
    // La alerta del 20 % se crea con evaluate_on_create: con créditos prorrateados (alta a final de mes) puede
    // nacer ya por debajo del umbral y avisar al momento, igual que haría Metronome.
    if (credits > 0 && credits < lowBalanceLimit(a)) pushAlert(a, "low_balance", `Tus créditos de este mes (prorrateados) son ${eur(credits)}, menos del 20 % del plan. ¿Quieres recargar?`);
    saveAccount(a);
    return a;
  },
  async get(customerId) {
    const a = getAccount(customerId);
    if (!a) return null;
    if (closePeriods(a)) saveAccount(a);
    return withWebhookAlerts(a);
  },
  async getInvoice(customerId, invoiceId) {
    const a = getAccount(customerId);
    if (!a) return null;
    if (invoiceId === "draft-current") return draftInvoice(a);
    return a.invoices.find(i => i.id === invoiceId) ?? null;
  },
  async changePlan(customerId, plan) {
    const a = load(customerId);
    if (!PLANS[plan]) throw new Error("Plan desconocido");
    if (a.plan === plan) {
      if (a.pendingPlan) { a.pendingPlan = undefined; pushAlert(a, "info", "Bajada de plan cancelada."); saveAccount(a); }
      return a;
    }
    const oldP = PLANS[a.plan], newP = PLANS[plan];
    const prev = balance(a);
    if (newP.rank > oldP.rank) {
      // Subida = transición RENEWAL inmediata: el contrato nuevo cobra la cuota prorrateada y trae sus créditos
      // prorrateados; el saldo no consumido del anterior (rollover_fraction 1) se conserva, igual que commits, regalos y promos.
      const ratio = remainingRatio(a);
      const fee = round2((newP.monthlyFee - oldP.monthlyFee) * ratio);
      const newCredits = round2(newP.monthlyCredits * ratio);
      charge(a, `Subida a ${newP.name} (prorrateo ${Math.round(ratio * 100)} % del mes)`, fee, "proration", [
        { description: `Suscripción ${newP.name} prorrateada (${Math.round(ratio * 100)} %)`, quantity: round(ratio), unitPrice: newP.monthlyFee, amount: round2(newP.monthlyFee * ratio), kind: "fee" },
        { description: `Abono suscripción ${oldP.name} no consumida`, quantity: round(ratio), unitPrice: -oldP.monthlyFee, amount: -round2(oldP.monthlyFee * ratio), kind: "fee" },
        { description: `Créditos ${newP.name} prorrateados (${eur(newCredits)})`, amount: 0, kind: "credit" },
      ], { periodStart: a.periodStart, periodEnd: a.periodEnd });
      for (const c of a.credits) if (c.kind === "recurring" && !c.label.includes("arrastrados")) c.label = `${c.label} (arrastrados)`;
      if (newCredits > 0) a.credits.unshift(recurringCredit(plan, newCredits, a.periodEnd, `Créditos ${newP.name} (prorrateados)`));
      a.plan = plan;
      a.pendingPlan = undefined;
      if (plan === "scale" && !a.autoRecharge) a.spendThreshold = { enabled: true, thresholdEur: SPEND_THRESHOLD.scaleThreshold, paymentGate: "STRIPE" };
      a.accessCut = false;
      pushAlert(a, "info", `Plan cambiado a ${newP.name}: +${eur(newCredits)} de créditos; conservas tu saldo anterior. Aviso de saldo bajo actualizado a ${eur(lowBalanceLimit(a))}.`);
      // Alerta del 20 % re-sincronizada (evaluate_on_create): si ya estás por debajo del nuevo umbral, avisa ya.
      const bal = balance(a);
      if (bal > 0 && bal < lowBalanceLimit(a)) pushAlert(a, "low_balance", `Te queda menos del 20 % de tus créditos del plan (${eur(bal)}).`);
    } else {
      // Bajada = transición que empieza el siguiente periodo. Hasta entonces sigues en el plan actual.
      a.pendingPlan = { plan, effectiveAt: a.periodEnd };
      pushAlert(a, "info", `Bajada a ${newP.name} programada para el ${fmtDay(a.periodEnd)}. Conservarás tus bundles, regalos y promociones.`);
    }
    evaluate(a, prev);
    saveAccount(a);
    return a;
  },
  async buyBundle(customerId, bundle, purchaseId) {
    const a = load(customerId);
    const b = BUNDLES[bundle];
    if (!b) throw new Error("Bundle desconocido");
    if (getPurchase(purchaseId)) return withWebhookAlerts(a); // reintento de la misma compra: idempotente
    addPurchase({ purchaseId, customerKey: customerId, contractId: customerId, bundle, status: "payment_pending", createdAt: nowIso() });
    const gift = b.credit - b.price;
    charge(a, `Compra de bundle: ${eur(b.price)}`, b.price, "commit", [
      { description: `Commit prepagado ${eur(b.price)} (válido ${b.validityMonths} meses)`, quantity: 1, unitPrice: b.price, amount: b.price, kind: "commit" },
      ...(gift > 0 ? [{ description: `Regalo ${eur(gift)} (sin coste, se añade al confirmarse el pago)`, quantity: 1, unitPrice: 0, amount: 0, kind: "credit" as const }] : []),
    ], { externalId: `purchase:${purchaseId}` });
    // Commit con payment gate: Metronome lo crea cuando Stripe cobra (en la simulación, al momento).
    a.credits.push({ id: id("cm"), kind: "commit", label: `Bundle ${eur(b.price)}`, amount: b.price, remaining: b.price, createdAt: nowIso(), expiresAt: addMonths(nowIso(), b.validityMonths), reference: purchaseId });
    a.accessCut = false;
    refreshBlocked(a);
    saveAccount(a);
    await simulatePaymentWebhook(customerId, purchaseId);
    return withWebhookAlerts(load(customerId));
  },
  async setAutoRecharge(customerId, enabled) {
    const a = load(customerId);
    if (enabled && !PLANS[a.plan].autoRechargeAllowed) throw new Error("La recarga automática solo está disponible en Pro y Scale");
    if (enabled && a.spendThreshold?.enabled) throw new Error("Desactiva antes el cobro anticipado por umbral (no se pueden combinar)");
    a.autoRecharge = enabled;
    if (enabled) evaluate(a, balance(a));
    saveAccount(a);
    return a;
  },
  async setSpendThreshold(customerId, enabled) {
    const a = load(customerId);
    if (enabled && a.plan !== "scale") throw new Error("El cobro anticipado por umbral solo está disponible en Scale");
    if (enabled && a.autoRecharge) throw new Error("Desactiva antes la recarga automática (no se pueden combinar)");
    a.spendThreshold = { enabled, thresholdEur: a.spendThreshold?.thresholdEur ?? SPEND_THRESHOLD.scaleThreshold, paymentGate: "STRIPE" };
    if (enabled) spendThresholdCheck(a);
    saveAccount(a);
    return a;
  },
  async redeemPromo(customerId, rawCode) {
    const a = load(customerId);
    const code = rawCode.trim().toUpperCase();
    const promo = PROMOTIONS[code];
    if (!promo) throw new Error("Código promocional no válido");
    if ((a.redeemedPromos ?? []).includes(code)) throw new Error(`Ya has canjeado el código ${code}`);
    const expiresAt = addDays(nowIso(), promo.validDays);
    a.credits.push({ id: id("pr"), kind: "promo", label: `${promo.label} (${code})`, amount: promo.amount, remaining: promo.amount, createdAt: nowIso(), expiresAt, reference: code });
    a.redeemedPromos = [...(a.redeemedPromos ?? []), code];
    a.accessCut = false;
    refreshBlocked(a);
    pushAlert(a, "info", `Código ${code} canjeado: ${eur(promo.amount)} de crédito hasta el ${fmtDay(expiresAt)}.`);
    saveAccount(a);
    return a;
  },
  async ingest(customerId, requests) {
    const a = load(customerId);
    const plan = PLANS[a.plan];
    const seen = new Set(a.seenRequests ?? []);
    let duplicates = 0, rejected = false;
    for (const r of requests) {
      if (!r.requestId) continue;
      if (seen.has(r.requestId)) { duplicates++; continue; } // igual que /v1/ingest: dedupe por transaction_id
      refreshBlocked(a);
      if (a.blocked) { rejected = true; break; }
      const ts = r.ts ?? nowIso();
      const prev = balance(a);
      const parts: [MetricId, number][] = [["input_tokens", r.inputTokens ?? 0], ["output_tokens", r.outputTokens ?? 0], ["images", r.images ?? 0]];
      for (const [metric, quantity] of parts) {
        if (!(quantity > 0)) continue;
        const cost = usageCost(metric, quantity, plan.discount);
        a.usage.unshift({ id: id("ev"), requestId: r.requestId, ts, metric, quantity, cost });
        addDaily(a, ts, metric, quantity, cost);
        const uncovered = deduct(a, cost);
        if (uncovered > 0 && plan.overage) a.overageAccrued = round(a.overageAccrued + uncovered);
      }
      seen.add(r.requestId);
      evaluate(a, prev);
    }
    a.seenRequests = [...seen].slice(-2000);
    a.usage = a.usage.slice(0, 500);
    saveAccount(a);
    return { account: a, rejected, duplicates };
  },
};
