// COPIA LITERAL de /workspace/metronome-setup/types.ts (contrato de datos del experto de Metronome). No editar aquí:
// si cambia, volver a copiar. Importes EUR en unidades enteras; fechas RFC 3339 UTC.
/**
 * Formas de datos que la UI web de nebula.ai consume, producidas por los helpers de
 * /workspace/metronome-setup/src/helpers. Archivo autocontenido (sin imports) para poder copiarlo tal cual.
 *
 * Convención: todos los importes son EUR en UNIDADES ENTERAS (10.5 = 10,50 €). Metronome solo usa
 * céntimos para USD; EUR va en unidades (docs: "Set currencies and custom pricing units").
 * Las fechas son strings RFC 3339 en UTC (tal como las devuelve Metronome).
 */

export type PlanKey = "free" | "pro" | "scale";
export type PaidPlanKey = Exclude<PlanKey, "free">;
export type MetricKey = "input_tokens" | "output_tokens" | "images";
export type BundleKey = "b50" | "b200" | "b1000";

// ───────────────────────────── Cliente y contrato ─────────────────────────────

export interface CustomerRef {
  metronomeCustomerId: string;
  /** Alias de ingesta (p. ej. id de usuario de la web); se puede usar como customer_id en /v1/ingest. */
  ingestAlias: string;
  stripeCustomerId: string;
}

export interface AutoRechargeState {
  enabled: boolean;
  thresholdEur: number;
  rechargeToEur: number;
  /** Validez de cada recarga (commit.duration; la API devuelve `value` como string → se convierte a número). */
  commitDuration?: { value: number; unit: "DAYS" | "WEEKS" | "MONTHS" | "YEARS" };
  rolloverFraction?: number;
  rateType?: "LIST_RATE" | "COMMIT_RATE";
}

export interface SpendThresholdState {
  enabled: boolean;
  /** Cada vez que el gasto del contrato alcanza este importe se cobra por adelantado (Stripe). */
  thresholdEur: number;
  paymentGate: "STRIPE" | "EXTERNAL" | "NONE";
}

export interface PlanContractSummary {
  contractId: string;
  customerId: string;
  plan: PlanKey | "enterprise" | "unknown";
  startingAt: string;
  endingBefore?: string;
  /** Ancla de los periodos de facturación mensuales (usage_statement_schedule.billing_anchor_date). */
  billingAnchorDate?: string;
  autoRecharge?: AutoRechargeState;
  spendThreshold?: SpendThresholdState;
}

/** Threshold billing still to add once a future-starting contract has started (the API rejects it before: 400). */
export type PendingThresholdConfig = "auto_recharge" | "spend_threshold" | "auto_recharge_and_spend_threshold";

/** Resultado de un cambio de plan. */
export interface PlanChangeResult {
  kind: "upgrade" | "downgrade" | "same";
  fromContractId: string;
  /** Contrato nuevo (transición RENEWAL). En bajadas empieza al inicio del siguiente periodo. */
  newContractId?: string;
  effectiveAt: string;
  /** El contrato nuevo empieza en el futuro: la API rechaza threshold billing ahí (400), se añade con finishPendingThresholdConfig. */
  pendingThresholdConfig?: PendingThresholdConfig;
}

// ───────────────────────────── Saldos ─────────────────────────────

export type GrantKind =
  | "plan_credit"
  | "bundle_commit"
  | "bundle_bonus"
  | "promo"
  | "auto_recharge"
  | "spend_threshold"
  | "enterprise_commit"
  | "other";

export interface CreditGrantView {
  id: string;
  kind: GrantKind;
  /** PREPAID/POSTPAID = commit; CREDIT = crédito gratuito. */
  metronomeType: "PREPAID" | "POSTPAID" | "CREDIT";
  name: string;
  productId: string;
  grantedEur: number;
  /** Saldo disponible AHORA (campo `balance` con include_balance=true). */
  remainingEur: number;
  startsAt?: string;
  expiresAt?: string;
  contractId?: string;
  /** Código de promoción o id de compra (custom fields nebula_promo / nebula_purchase_id). */
  reference?: string;
}

export interface BalanceSummary {
  customerId: string;
  currency: "EUR";
  /** /v1/contracts/customerBalances/getNetBalance */
  netBalanceEur: number;
  grants: CreditGrantView[];
  asOf: string;
}

// ───────────────────────────── Facturas ─────────────────────────────

export type InvoiceLineType =
  | "usage"
  | "subscription"
  | "commit_purchase"
  | "scheduled"
  | "applied_commit_or_credit"
  | "cpu_conversion"
  | string;

export interface InvoiceLineView {
  name: string;
  type: InvoiceLineType;
  quantity?: number;
  unitPriceEur?: number;
  totalEur: number;
  productId?: string;
  isProrated?: boolean;
  /** Para líneas negativas de consumo de crédito/commit. */
  appliedCommitOrCreditId?: string;
  startingAt?: string;
  endingBefore?: string;
}

export interface InvoiceView {
  id: string;
  /** Metronome: DRAFT | FINALIZED | VOID */
  status: string;
  /** Metronome: USAGE | SCHEDULED | USAGE_CONSOLIDATED */
  type: string;
  contractId?: string;
  issuedAt?: string;
  periodStart?: string;
  periodEnd?: string;
  totalEur: number;
  currency: string;
  lines: InvoiceLineView[];
  /** external_invoice (Stripe) */
  stripeInvoiceId?: string;
  stripeStatus?: string;
  /** external_invoice.billing_provider_error (e.g. "No such customer: 'cus_…'"). */
  stripeError?: string;
  /** Raw billable_status from Metronome ("billable" | "unbillable"; other values kept for the admin panel). */
  billableStatus?: string;
  pdfUrl?: string;
}

/**
 * Vista previa de la factura del ciclo en curso. Metronome no tiene endpoint de "upcoming invoice":
 * las facturas USAGE del periodo abierto existen como DRAFT y se actualizan en tiempo real con cada evento.
 */
export interface UpcomingInvoicePreview {
  customerId: string;
  contractId?: string;
  periodStart?: string;
  periodEnd?: string;
  /** Suma de líneas usage + subscription (antes de créditos). */
  grossChargesEur: number;
  /** Suma (en positivo) de líneas applied_commit_or_credit. */
  creditsAppliedEur: number;
  /** `total` de las facturas DRAFT: lo que se cobraría hoy si el periodo cerrara ahora. */
  totalDueEur: number;
  lines: InvoiceLineView[];
  draftInvoiceIds: string[];
  asOf: string;
}

// ───────────────────────────── Bundles / promociones ─────────────────────────────

export interface BundlePurchaseResult {
  bundle: BundleKey;
  purchaseId: string;
  contractId: string;
  editId: string;
  paidEur: number;
  bonusEur: number;
  /** El commit queda pendiente hasta el webhook payment_gate.payment_status = paid. */
  status: "payment_pending";
}

export interface PromoCreditResult {
  code: string;
  label: string;
  amountEur: number;
  startsAt: string;
  expiresAt: string;
  contractId: string;
  editId: string;
}

// ───────────────────────────── Uso / recomendador ─────────────────────────────

export interface DailyValue {
  /** Inicio del día (UTC, medianoche). */
  day: string;
  value: number;
}

export interface MetricUsage {
  metric: MetricKey;
  billableMetricId: string;
  /** Unidades crudas (tokens o imágenes). */
  total: number;
  daily: DailyValue[];
  /** Coste a precio de lista (sin descuentos ni créditos). */
  listCostEur: number;
}

export interface UsageLast30Days {
  customerId: string;
  windowStart: string;
  windowEnd: string;
  metrics: Record<MetricKey, MetricUsage>;
  totalListCostEur: number;
}

export interface PlanCostEstimate {
  plan: PlanKey;
  monthlyFeeEur: number;
  usageCostAfterDiscountEur: number;
  includedCreditsEur: number;
  /** Lo que pagaría en bundles/overage por encima de los créditos incluidos. */
  extraEur: number;
  totalMonthlyEur: number;
}

export interface PlanRecommendation {
  basedOn: UsageLast30Days;
  estimates: PlanCostEstimate[];
  recommended: PlanKey;
  /** Ahorro mensual estimado frente al plan actual (si se conoce). */
  savingsVsCurrentEur?: number;
}

// ───────────────────────────── Enterprise ─────────────────────────────

export interface EnterpriseRateOverride {
  metric: MetricKey;
  /** Precio negociado (EUR por unidad convertida: por 1M tokens o por imagen). */
  priceEur: number;
}

export interface EnterpriseContractTerms {
  customerId: string;
  /** Inicio (se trunca a la hora). Por defecto: ahora. */
  startingAt?: string;
  termMonths?: number;
  /** Compromiso anual en EUR. */
  commitAmountEur: number;
  /**
   * POSTPAID = gasto mínimo anual: el uso consume el compromiso y al final se factura la diferencia (true-up).
   * PREPAID = el cliente paga el compromiso por adelantado (una factura al inicio).
   */
  commitType: "POSTPAID" | "PREPAID";
  /** Precios negociados por métrica (override OVERWRITE). */
  rateOverrides?: EnterpriseRateOverride[];
  /** Descuento global sobre el uso (override MULTIPLIER, p. ej. 0.85). Se combina con rateOverrides. */
  usageMultiplier?: number;
  netPaymentTermsDays?: number;
  uniquenessKey?: string;
}

export interface EnterpriseContractSummary {
  contractId: string;
  customerId: string;
  startingAt: string;
  endingBefore: string;
  commitType: "POSTPAID" | "PREPAID";
  commitAmountEur: number;
  rateOverrides: EnterpriseRateOverride[];
  usageMultiplier?: number;
}

// ───────────────────────────── Webhooks ─────────────────────────────

export type MetronomeWebhookType =
  | "alerts.low_remaining_contract_credit_and_commit_balance_reached"
  | "payment_gate.threshold_reached"
  | "payment_gate.payment_status"
  | "payment_gate.payment_pending_action_required"
  | "payment_gate.external_initiate"
  | "invoice.finalized"
  | "invoice.billing_provider_error"
  | "contract.create"
  | "contract.start"
  | "contract.edit"
  | "contract.end"
  | "contract.archive"
  | string;

export interface MetronomeWebhookEvent<P = Record<string, unknown>> {
  id: string;
  type: MetronomeWebhookType;
  properties: P;
}

export interface BalanceAlertProperties {
  customer_id: string;
  alert_id: string;
  alert_name: string;
  timestamp: string;
  threshold: number;
  remaining_balance: number;
  credit_type_id?: string;
  triggered_by?: string;
}

export interface PaymentGateProperties {
  /** Documentados en los ejemplos: "manual_commit" (commit con payment gate, p. ej. bundle) y "spend" (spend threshold). */
  workflow_type?: string;
  customer_id: string;
  contract_id: string;
  invoice_id?: string;
  workflow_id?: string;
  payment_status?: "paid" | "failed";
  error_message?: string;
  timestamp?: string;
  billing_provider?: { type: string; stripe?: { payment_intent_id?: string; error?: Record<string, unknown> } };
}

/** Acción que la web debe tomar tras procesar un webhook (ver helpers/webhooks.ts). */
export type WebhookAction =
  | { action: "offer_top_up"; customerId: string; remainingEur: number }
  | { action: "cut_access"; customerId: string }
  /** Pago OK (bundle, recarga o spend threshold). Si había una compra de bundle pendiente en ese contrato ⇒ grantBundleBonus + restaurar acceso. */
  | { action: "payment_succeeded"; customerId: string; contractId: string; invoiceId?: string; workflowType?: string }
  | { action: "payment_failed"; customerId: string; contractId: string; message?: string; workflowType?: string }
  | { action: "payment_requires_action"; customerId: string; contractId: string; paymentIntentId?: string }
  | { action: "threshold_charge_started"; customerId: string; contractId: string; workflowType?: string }
  | { action: "ignore" };
