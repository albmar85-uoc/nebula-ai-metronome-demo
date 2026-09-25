import { balance, draftInvoice, withInsights } from "./billing/mock";
import type { Account } from "./billing/types";

/** Vista que se envía al navegador: saldo total, vistas calculadas (próxima factura, uso 30 días) y borrador de uso. */
export const view = (a: Account) => {
  const full = a.mode === "mock" ? withInsights(a) : a;
  return {
    ...full,
    seenRequests: undefined, // interno
    usage: full.usage.slice(0, 100),
    balance: balance(full),
    invoices: a.mode === "mock" ? [draftInvoice(a), ...a.invoices] : a.invoices,
  };
};
