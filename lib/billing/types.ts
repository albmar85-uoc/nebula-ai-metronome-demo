import type { BundleId, MetricId, PlanId } from "../catalog";

export type CreditGrant = {
  id: string;
  kind: "recurring" | "commit" | "gift"; // crédito mensual, commit prepagado, saldo de regalo
  label: string;
  amount: number;
  remaining: number;
  createdAt: string;
};

export type InvoiceLine = { description: string; quantity?: number; unitPrice?: number; amount: number; kind?: "fee" | "usage" | "commit" | "credit" | "discount" };
export type Invoice = {
  id: string;
  date: string;
  description: string;
  amount: number;
  status: "paid" | "pending" | "draft" | "void";
  type?: "subscription" | "commit" | "usage" | "proration";
  periodStart?: string;
  periodEnd?: string;
  lines?: InvoiceLine[];
  externalId?: string; // p. ej. id de la factura o PaymentIntent en Stripe
  pdfUrl?: string;
};
export type UsageEvent = { id: string; ts: string; metric: MetricId; quantity: number; cost: number };
export type DailyUsage = { day: string; metric: MetricId; quantity: number; cost: number }; // day = AAAA-MM-DD
export type Alert = { id: string; ts: string; type: "low_balance" | "zero_balance" | "auto_recharge" | "payment" | "info"; message: string; source?: "local" | "webhook"; verified?: boolean };

export type Account = {
  customerId: string;
  name: string;
  email: string;
  plan: PlanId;
  pendingPlan?: { plan: PlanId; effectiveAt: string }; // bajadas de plan programadas
  cardSaved: boolean;
  autoRecharge: boolean;
  blocked: boolean;
  overageAccrued: number;
  credits: CreditGrant[];
  usage: UsageEvent[];
  daily?: DailyUsage[];
  invoices: Invoice[];
  alerts: Alert[];
  periodStart: string;
  periodEnd: string;
  mode: "mock" | "metronome";
};

export type SignupInput = { name: string; email: string; plan: PlanId; stripeCustomerId?: string };
export type IngestEvent = { metric: MetricId; quantity: number; ts?: string };

export interface BillingProvider {
  mode: "mock" | "metronome";
  signup(input: SignupInput): Promise<Account>;
  get(customerId: string): Promise<Account | null>;
  changePlan(customerId: string, plan: PlanId): Promise<Account>;
  buyBundle(customerId: string, bundle: BundleId): Promise<Account>;
  setAutoRecharge(customerId: string, enabled: boolean): Promise<Account>;
  ingest(customerId: string, events: IngestEvent[]): Promise<{ account: Account; rejected: boolean }>;
  getInvoice?(customerId: string, invoiceId: string): Promise<Invoice | null>;
}
