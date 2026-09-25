// Simulación del comportamiento de Metronome + Stripe, persistida en ./data/db.json.
// Reproduce: contrato con cuota fija, créditos recurrentes, commits prepagados,
// créditos de regalo, precios especiales por plan, prorrateo, alertas y recarga automática.
import { AUTO_RECHARGE, BUNDLES, LOW_BALANCE_RATIO, METRICS, PLANS, eur, type BundleId, type MetricId } from "../catalog";
import { getAccount, getAlerts, saveAccount } from "../store";
import type { Account, Alert, BillingProvider, CreditGrant, DailyUsage, Invoice, InvoiceLine } from "./types";

const id = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();
export const round = (n: number) => Math.round(n * 10000) / 10000;

export const balance = (a: Pick<Account, "credits">) => round(a.credits.reduce((s, c) => s + c.remaining, 0));

/** Periodo de facturación = mes natural en UTC (igual que usage_statement_schedule FIRST_OF_MONTH en Metronome). */
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
  a.alerts.unshift({ id: id("al"), ts: now(), type, message, source: "local" });
  a.alerts = a.alerts.slice(0, 30);
}

function charge(a: Account, description: string, amount: number, type: Invoice["type"], lines?: InvoiceLine[]) {
  // En producción: Metronome emite la factura y la cobra en Stripe sobre la tarjeta guardada.
  if (amount <= 0) return;
  a.invoices.unshift({
    id: id("in"), date: now(), description, amount: round(amount), status: "paid", type,
    lines: lines ?? [{ description, quantity: 1, unitPrice: round(amount), amount: round(amount) }],
    externalId: `pi_sim_${Math.random().toString(36).slice(2, 12)}`,
  });
}

function addBundle(a: Account, bundle: BundleId, reason: string) {
  const b = BUNDLES[bundle];
  const gift = b.credit - b.price;
  charge(a, `${reason}: recarga de ${eur(b.price)}`, b.price, "commit", [
    { description: `Commit prepagado ${eur(b.price)}`, quantity: 1, unitPrice: b.price, amount: b.price, kind: "commit" },
    ...(gift > 0 ? [{ description: `Saldo de regalo ${eur(gift)} (sin coste)`, quantity: 1, unitPrice: 0, amount: 0, kind: "credit" as const }] : []),
  ]);
  // El saldo se libera cuando Stripe confirma el pago (en la simulación, siempre al momento).
  a.credits.push({ id: id("cm"), kind: "commit", label: `Commit prepagado ${eur(b.price)}`, amount: b.price, remaining: b.price, createdAt: now() });
  if (gift > 0) a.credits.push({ id: id("gf"), kind: "gift", label: `Saldo de regalo (${eur(gift)})`, amount: gift, remaining: gift, createdAt: now() });
  a.blocked = false;
}

function reference(a: Account) {
  // Referencia para la alerta del 20 %: créditos del plan o el mayor commit comprado.
  return Math.max(PLANS[a.plan].monthlyCredits, ...a.credits.filter(c => c.kind === "commit").map(c => c.amount), 1);
}
export const lowBalanceLimit = (a: Account) => reference(a) * LOW_BALANCE_RATIO;

function evaluate(a: Account, prevBalance: number) {
  const bal = balance(a);
  const plan = PLANS[a.plan];
  if (a.autoRecharge && plan.autoRechargeAllowed && bal < AUTO_RECHARGE.threshold) {
    addBundle(a, AUTO_RECHARGE.bundle, "Recarga automática");
    pushAlert(a, "auto_recharge", `El saldo bajó de ${eur(AUTO_RECHARGE.threshold)} y se recargó automáticamente.`);
    return;
  }
  const lim = lowBalanceLimit(a);
  if (prevBalance >= lim && bal < lim && bal > 0) pushAlert(a, "low_balance", `Te queda menos del 20 % del saldo (${eur(bal)}). ¿Quieres recargar?`);
  if (bal <= 0 && prevBalance > 0) {
    if (plan.overage) pushAlert(a, "zero_balance", "Saldo agotado. El uso extra se facturará a fin de mes.");
    else { a.blocked = true; pushAlert(a, "zero_balance", "Saldo agotado. El acceso a la API se ha pausado hasta que recargues o subas de plan."); }
  }
}

/** Orden de consumo: créditos mensuales → regalo → commits (en Metronome: priority 1, 2, 3). */
export const DEDUCTION_ORDER: CreditGrant["kind"][] = ["recurring", "gift", "commit"];
export function deduct(a: Pick<Account, "credits">, cost: number): number {
  let left = cost;
  for (const k of DEDUCTION_ORDER) for (const c of a.credits.filter(x => x.kind === k)) {
    if (left <= 0) break;
    const take = Math.min(c.remaining, left);
    c.remaining = round(c.remaining - take);
    left = round(left - take);
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
  a.daily = daily.sort((x, y) => x.day.localeCompare(y.day)).slice(-3 * 90);
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
  return {
    id: "draft-current", date: now(), description: `Uso del periodo (borrador)`, amount: round(a.overageAccrued), status: "draft", type: "usage",
    periodStart: a.periodStart, periodEnd: a.periodEnd, lines,
  };
}

function load(customerId: string): Account {
  const a = getAccount(customerId);
  if (!a) throw new Error("Cliente no encontrado");
  return a;
}

/** Mezcla las alertas locales con las recibidas por webhook (si alguien envía uno en modo simulado). */
function withWebhookAlerts(a: Account): Account {
  const ext = getAlerts(a.customerId);
  if (!ext.length) return a;
  return { ...a, alerts: [...a.alerts, ...ext].sort((x, y) => y.ts.localeCompare(x.ts)).slice(0, 40) };
}

export const mockBilling: BillingProvider = {
  mode: "mock",
  async signup({ name, email, plan }) {
    const { start, end } = monthBounds();
    const p = PLANS[plan];
    const a: Account = {
      customerId: id("cus"), name, email, plan, cardSaved: true, autoRecharge: false, blocked: false, overageAccrued: 0,
      credits: [{ id: id("rc"), kind: "recurring", label: `Créditos mensuales ${p.name}`, amount: p.monthlyCredits, remaining: p.monthlyCredits, createdAt: now() }],
      usage: [], daily: [], invoices: [], alerts: [], periodStart: start.toISOString(), periodEnd: end.toISOString(), mode: "mock",
    };
    charge(a, `Cuota mensual ${p.name}`, p.monthlyFee, "subscription", [
      { description: `Suscripción ${p.name} (${start.toLocaleDateString("es-ES", { timeZone: "UTC" })} – ${new Date(+end - 1).toLocaleDateString("es-ES", { timeZone: "UTC" })})`, quantity: 1, unitPrice: p.monthlyFee, amount: p.monthlyFee, kind: "fee" },
      { description: `Créditos mensuales incluidos (${eur(p.monthlyCredits)})`, amount: 0, kind: "credit" },
    ]);
    pushAlert(a, "info", `Cuenta creada en el plan ${p.name}. Tarjeta guardada en Stripe.`);
    saveAccount(a);
    return a;
  },
  async get(customerId) {
    const a = getAccount(customerId);
    return a ? withWebhookAlerts(a) : null;
  },
  async getInvoice(customerId, invoiceId) {
    const a = getAccount(customerId);
    if (!a) return null;
    if (invoiceId === "draft-current") return draftInvoice(a);
    return a.invoices.find(i => i.id === invoiceId) ?? null;
  },
  async changePlan(customerId, plan) {
    const a = load(customerId);
    if (a.plan === plan) return a;
    const oldP = PLANS[a.plan], newP = PLANS[plan];
    const ratio = remainingRatio(a);
    const prev = balance(a);
    if (newP.monthlyFee > oldP.monthlyFee) {
      // Upgrade: cobro inmediato del prorrateo y créditos adicionales proporcionales.
      const fee = round((newP.monthlyFee - oldP.monthlyFee) * ratio);
      const extra = round((newP.monthlyCredits - oldP.monthlyCredits) * ratio);
      charge(a, `Upgrade a ${newP.name} (prorrateo ${Math.round(ratio * 100)} % del mes)`, fee, "proration", [
        { description: `Suscripción ${newP.name} prorrateada (${Math.round(ratio * 100)} %)`, quantity: ratio, unitPrice: newP.monthlyFee, amount: round(newP.monthlyFee * ratio), kind: "fee" },
        { description: `Abono suscripción ${oldP.name} no consumida`, quantity: ratio, unitPrice: -oldP.monthlyFee, amount: -round(oldP.monthlyFee * ratio), kind: "fee" },
      ]);
      if (extra > 0) a.credits.push({ id: id("rc"), kind: "recurring", label: `Créditos ${newP.name} (prorrateados)`, amount: extra, remaining: extra, createdAt: now() });
      pushAlert(a, "info", `Plan cambiado a ${newP.name}. Se han añadido ${eur(extra)} de créditos.`);
    } else {
      // Downgrade: en la demo se aplica ya, sin reembolso; la nueva cuota se cobra desde el próximo ciclo.
      pushAlert(a, "info", `Plan cambiado a ${newP.name}. El nuevo precio se aplica desde el próximo ciclo.`);
    }
    a.plan = plan;
    if (!newP.autoRechargeAllowed) a.autoRecharge = false;
    if (balance(a) > 0 || newP.overage) a.blocked = false;
    evaluate(a, prev);
    saveAccount(a);
    return a;
  },
  async buyBundle(customerId, bundle) {
    const a = load(customerId);
    if (!BUNDLES[bundle]) throw new Error("Bundle desconocido");
    addBundle(a, bundle, "Compra de bundle");
    pushAlert(a, "info", `Bundle comprado: ${eur(BUNDLES[bundle].credit)} de saldo.`);
    saveAccount(a);
    return a;
  },
  async setAutoRecharge(customerId, enabled) {
    const a = load(customerId);
    if (enabled && !PLANS[a.plan].autoRechargeAllowed) throw new Error("La recarga automática solo está disponible en Pro y Scale");
    a.autoRecharge = enabled;
    if (enabled) evaluate(a, balance(a));
    saveAccount(a);
    return a;
  },
  async ingest(customerId, events) {
    const a = load(customerId);
    if (a.blocked) return { account: a, rejected: true };
    const plan = PLANS[a.plan];
    for (const e of events) {
      if (!(e.metric in METRICS) || !(e.quantity > 0)) continue;
      const prev = balance(a);
      const ts = e.ts ?? now();
      const cost = usageCost(e.metric, e.quantity, plan.discount);
      a.usage.unshift({ id: id("ev"), ts, metric: e.metric, quantity: e.quantity, cost });
      addDaily(a, ts, e.metric, e.quantity, cost);
      const uncovered = deduct(a, cost);
      if (uncovered > 0 && plan.overage) a.overageAccrued = round(a.overageAccrued + uncovered);
      evaluate(a, prev);
      if (a.blocked) break;
    }
    a.usage = a.usage.slice(0, 500);
    saveAccount(a);
    return { account: a, rejected: false };
  },
};
