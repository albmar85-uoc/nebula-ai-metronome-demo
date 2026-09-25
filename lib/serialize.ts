import { balance, draftInvoice } from "./billing/mock";
import type { Account } from "./billing/types";

/** Vista que se envía al navegador: añade el saldo total y, en modo simulado, la factura de uso en borrador. */
export const view = (a: Account) => ({
  ...a,
  balance: balance(a),
  invoices: a.mode === "mock" ? [draftInvoice(a), ...a.invoices] : a.invoices,
});
