import type { BundleId, MetricId, PlanId } from "../catalog";
import type { SpendThresholdState, UpcomingInvoicePreview, UsageLast30Days } from "./metronome-types";
import type { PlanComparison } from "./insights";

export type CreditGrant = {
  id: string;
  // crédito mensual, promo con caducidad, saldo de regalo del bundle, commit prepagado (bundle / recarga / umbral)
  kind: "recurring" | "promo" | "gift" | "commit";
  label: string;
  amount: number;
  remaining: number;
  createdAt: string;
  expiresAt?: string;
  reference?: string; // purchaseId del bundle o código promocional
};

export type InvoiceLine = { description: string; quantity?: number; unitPrice?: number; amount: number; kind?: "fee" | "usage" | "commit" | "credit" | "discount" };
export type Invoice = {
  id: string;
  date: string;
  description: string;
  amount: number;
  status: "paid" | "pending" | "draft" | "void" | "failed";
  /** Raw billing-provider error when the charge failed (admin only; customers see a generic message). */
  paymentError?: string;
  type?: "subscription" | "commit" | "usage" | "proration" | "threshold";
  periodStart?: string;
  periodEnd?: string;
  lines?: InvoiceLine[];
  externalId?: string; // p. ej. id de la factura o PaymentIntent en Stripe
  pdfUrl?: string;
};
export type UsageEvent = { id: string; requestId?: string; ts: string; metric: MetricId; quantity: number; cost: number; source?: UsageSource };
export type UsageSource = "api" | "simulator";
export type DailyUsage = { day: string; metric: MetricId; quantity: number; cost: number }; // day = AAAA-MM-DD (UTC)
export type Alert = { id: string; ts: string; type: "low_balance" | "zero_balance" | "auto_recharge" | "payment" | "info" | "spend_cap" | "support"; message: string; source?: "local" | "webhook"; verified?: boolean };

export type Account = {
  customerId: string;
  name: string;
  email: string;
  plan: PlanId;
  pendingPlan?: { plan: PlanId; effectiveAt: string }; // bajadas de plan programadas al siguiente periodo
  cardSaved: boolean;
  autoRecharge: boolean;
  spendThreshold?: SpendThresholdState; // solo Scale
  blocked: boolean;
  accessCut?: boolean; // corte por webhook de saldo 0 (Free/Pro) o pago de umbral fallido
  overageAccrued: number;
  spendPrepaid?: number; // cobrado por adelantado por el spend threshold en el periodo actual
  credits: CreditGrant[];
  usage: UsageEvent[];
  daily?: DailyUsage[];
  seenRequests?: string[]; // ids de petición ya contabilizados (idempotencia, como transaction_id en Metronome)
  redeemedPromos?: string[];
  /** Límite de gasto mensual fijado por el cliente (€, uso con descuento del periodo). Al alcanzarlo, la API responde 402. */
  spendCap?: SpendCap;
  invoices: Invoice[];
  alerts: Alert[];
  periodStart: string;
  periodEnd: string;
  mode: "mock" | "metronome";
  // Vistas calculadas (formas de metronome-types.ts)
  upcoming?: UpcomingInvoicePreview;
  usage30?: UsageLast30Days;
  recommendation?: PlanComparison;
};

export type SpendCap = { monthlyEur: number; alerted80At?: string; alerted100At?: string };
/** Quién hace una acción de cuenta (para el historial y el registro de soporte). */
export type Actor = "customer" | "support" | "system";
export type RejectReason = "blocked" | "spend_cap" | "insufficient_balance";

export type SignupInput = { name: string; email: string; plan: PlanId; stripeCustomerId?: string };
/** Una petición de IA de la app. requestId es el id de la petición y se usa como transaction_id en /v1/ingest. */
/** maxOutputTokens: upper bound for output (e.g. max_tokens) used to reserve the worst-case cost on prepaid-only plans. */
export type UsageRequest = { requestId: string; inputTokens?: number; outputTokens?: number; maxOutputTokens?: number; images?: number; model?: string; ts?: string; source?: UsageSource };

export interface BillingProvider {
  mode: "mock" | "metronome";
  signup(input: SignupInput): Promise<Account>;
  get(customerId: string): Promise<Account | null>;
  changePlan(customerId: string, plan: PlanId, actor?: Actor): Promise<Account>;
  /** purchaseId: id de compra de la app (idempotencia y correlación del regalo). */
  buyBundle(customerId: string, bundle: BundleId, purchaseId: string): Promise<Account>;
  setAutoRecharge(customerId: string, enabled: boolean): Promise<Account>;
  setSpendThreshold(customerId: string, enabled: boolean): Promise<Account>;
  redeemPromo(customerId: string, code: string): Promise<Account>;
  ingest(customerId: string, requests: UsageRequest[]): Promise<{ account: Account; rejected: boolean; reason?: RejectReason; duplicates: number; accepted: string[] }>;
  /** Límite de gasto mensual del cliente (null = sin límite). */
  setSpendCap(customerId: string, monthlyEur: number | null): Promise<Account>;
  /** Soporte: crédito de cortesía (idempotente por grantId). */
  grantGoodwill(customerId: string, g: { grantId: string; amountEur: number; reason: string; validDays: number }): Promise<Account>;
  /** Soporte: levanta el corte de acceso (webhook de saldo 0 / pago fallido). No crea saldo. */
  unblock(customerId: string): Promise<Account>;
  getInvoice(customerId: string, invoiceId: string): Promise<Invoice | null>;
}

/** A charge could not be completed (Stripe declined, Metronome payment gate failed, billing provider misconfigured). */
export class PaymentFailedError extends Error {
  readonly code = "payment_failed";
  constructor(message: string, readonly detail?: string) { super(message); this.name = "PaymentFailedError"; }
}

/** Customer-facing English message for a failed charge; the raw provider error goes to the server log only. */
export function paymentFailedMessage(what: string) {
  return `Payment failed: we couldn't charge your card for ${what}, so nothing was added to your balance and you haven't been charged. Please check your payment method or try again later.`;
}
