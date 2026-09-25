import { balance, draftInvoice, withInsights } from "./billing/mock";
import { periodSpend } from "./billing/limits";
import type { Account } from "./billing/types";
import { clockOffsetMs, nowIso } from "./clock";

/** Vista que se envía al navegador: saldo total, vistas calculadas (próxima factura, uso 30 días) y borrador de uso. */
export const view = (a: Account) => {
  const full = a.mode === "mock" ? withInsights(a) : a;
  return {
    ...full,
    seenRequests: undefined, // interno
    usage: full.usage.slice(0, 100),
    balance: balance(full),
    spent: periodSpend(full.daily, full.periodStart),
    capReached: !!full.spendCap && (periodSpend(full.daily, full.periodStart) >= full.spendCap.monthlyEur - 0.005 || full.spendCap.alerted100At === full.periodStart),
    invoices: a.mode === "mock" ? [draftInvoice(a), ...a.invoices] : a.invoices,
    now: nowIso(), // reloj de la demo (en simulado puede ir adelantado con «Fast-forward»)
    clockOffsetMs: clockOffsetMs(),
  };
};
