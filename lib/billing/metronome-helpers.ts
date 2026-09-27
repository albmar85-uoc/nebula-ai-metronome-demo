// Port de /workspace/metronome-setup/src/helpers/* a @metronome/sdk 3.10.0 (mismos nombres de función y mismos
// cuerpos de petición; el setup usa un cliente HTTP propio y aquí se usa el SDK oficial para que tsc valide cada
// cuerpo contra los tipos generados del OpenAPI). Si el experto cambia un helper, replicar el cambio aquí.
// Tabla helper → endpoint → método del SDK: README del setup, sección 5.
import Metronome from "@metronome/sdk";
import { AUTO_RECHARGE, AUTO_RECHARGE_COMMIT_TERMS, AUTO_RECHARGE_PLANS_ERROR, BUNDLES, LOW_BALANCE_RATIO, PLANS, PRIORITIES, SPEND_THRESHOLD, type BundleId, type MetricId, type PlanId } from "../catalog";
import { round2 } from "./insights";
import type { MetronomeIds, SubscriptionPlanKey } from "./metronome-config";
import type {
  AutoRechargeState, BalanceSummary, CreditGrantView, CustomerRef, GrantKind, InvoiceLineView, InvoiceView, MetronomeWebhookEvent,
  BalanceAlertProperties, PaymentGateProperties, PlanChangeResult, PlanContractSummary, PromoCreditResult, SpendThresholdState,
  UpcomingInvoicePreview, UsageLast30Days, WebhookAction, BundlePurchaseResult, MetricUsage,
} from "./metronome-types";
import { METRICS } from "../catalog";
import { DEMO_CUSTOMER_PREFIX, DemoLimitError, isArchivableDemoCustomer } from "./types";

/** Contexto que reciben todos los helpers (en el setup: { client: MetronomeClient; ids }). */
export type Ctx = { client: Metronome; ids: MetronomeIds };
export const USAGE_TAG = "nebula_usage";

export function floorToHour(d: Date = new Date()): string { const x = new Date(d); x.setUTCMinutes(0, 0, 0); return x.toISOString(); }
export function addMonths(iso: string, months: number): string { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString(); }
/** EUR va en unidades enteras (amount_scale = 1); USD sería 100. */
const amt = (ctx: Ctx, eurAmount: number) => Math.round(eurAmount * (ctx.ids.amount_scale || 1) * 10000) / 10000;
const fromAmt = (ctx: Ctx, v: number | null | undefined) => round2((v ?? 0) / (ctx.ids.amount_scale || 1));
export const isConflict = (e: unknown) => e instanceof Metronome.APIError && e.status === 409;

// ───────────────────────────── customers.ts ─────────────────────────────

export type CreateCustomerInput = { name: string; ingestAlias: string; stripeCustomerId: string; stripeCollectionMethod?: "charge_automatically" | "send_invoice"; deliveryMethodId?: string };

function stripeBillingConfig(input: Pick<CreateCustomerInput, "stripeCustomerId" | "stripeCollectionMethod" | "deliveryMethodId">) {
  return {
    billing_provider: "stripe" as const,
    configuration: { stripe_customer_id: input.stripeCustomerId, stripe_collection_method: input.stripeCollectionMethod ?? "charge_automatically" },
    ...(input.deliveryMethodId ? { delivery_method_id: input.deliveryMethodId } : { delivery_method: "direct_to_billing_provider" as const }),
  };
}

export function buildCreateCustomerBody(input: CreateCustomerInput): Metronome.V1.CustomerCreateParams {
  return { name: input.name, ingest_aliases: [input.ingestAlias], customer_billing_provider_configurations: [stripeBillingConfig(input)] };
}

export async function findCustomerByIngestAlias(ctx: Ctx, ingestAlias: string) {
  for await (const c of ctx.client.v1.customers.list({ ingest_alias: ingestAlias })) return c;
  return undefined;
}

/** Idempotente: si ya existe un cliente con ese ingest alias, lo devuelve sin crear otro. */
export async function createCustomerWithStripe(ctx: Ctx, input: CreateCustomerInput): Promise<CustomerRef> {
  const existing = await findCustomerByIngestAlias(ctx, input.ingestAlias);
  if (existing) return { metronomeCustomerId: existing.id, ingestAlias: input.ingestAlias, stripeCustomerId: input.stripeCustomerId };
  let res;
  try {
    res = await ctx.client.v1.customers.create(buildCreateCustomerBody(input));
  } catch (e) {
    // Seen live: with a Stripe billing config, Metronome masks the Trial limit ("Trial accounts are limited to 5 active
    // customers") as 404 "The specified customer was not found". Both map to a clear demo-limit message.
    const msg = (e as Error).message;
    if (/Trial accounts are limited|specified customer was not found/i.test(msg)) {
      console.error("[metronome] customer create rejected (Trial limit of 5 active customers, or Stripe customer not in the connected account):", msg);
      throw new DemoLimitError(msg);
    }
    throw e;
  }
  return { metronomeCustomerId: res.data.id, ingestAlias: input.ingestAlias, stripeCustomerId: input.stripeCustomerId };
}

// ───────────────────────────── contracts.ts ─────────────────────────────

export type PlanContractOptions = {
  customerId: string; plan: PlanId; startingAt?: string; billingAnchorDate?: string; fromContractId?: string;
  autoRecharge?: boolean; spendThreshold?: boolean; uniquenessKey?: string;
};

/** customerBalances/list (contracts.listBalances) rejects limit > 25 (undocumented; seen in the sandbox). The SDK iterator paginates. */
export const BALANCES_PAGE_LIMIT = 25;

export const STRIPE_PAYMENT_INTENT_GATE = { payment_gate_type: "STRIPE", tax_type: "NONE", stripe_config: { payment_type: "PAYMENT_INTENT" } } as const;

export function buildPrepaidBalanceThresholdConfig(ctx: Ctx, enabled = true) {
  return {
    is_enabled: enabled,
    threshold_amount: amt(ctx, ctx.ids.auto_recharge?.threshold_eur ?? AUTO_RECHARGE.threshold),
    recharge_to_amount: amt(ctx, ctx.ids.auto_recharge?.recharge_to_eur ?? AUTO_RECHARGE.rechargeTo),
    commit: {
      product_id: ctx.ids.products.fixed.auto_recharge,
      name: "Auto-recharge",
      priority: PRIORITIES.autoRecharge,
      applicable_product_tags: [USAGE_TAG],
      // `duration`, `rollover_fraction` y `rate_type` van DENTRO de `commit` (a nivel superior: 200 pero se ignoran). No están en
      // las typings de @metronome/sdk 3.10.0 → cast estrecho; el SDK envía el cuerpo tal cual.
      // Verified live (sandbox): stored as duration {value:"12",unit:"MONTHS"}, rollover_fraction 1, rate_type LIST_RATE.
      ...(buildAutoRechargeCommitTerms() as object),
    },
    payment_gate_config: STRIPE_PAYMENT_INTENT_GATE,
  } satisfies Metronome.V1.ContractCreateParams["prepaid_balance_threshold_configuration"];
}

export type AutoRechargeCommitTerms = { duration: { value: number; unit: string }; rollover_fraction: number; rate_type: string };

/** Condiciones del commit de cada recarga: 12 meses de validez, se traspasa íntegro (rollover 1) en cambios de plan, a precio de lista. */
export function buildAutoRechargeCommitTerms(terms = AUTO_RECHARGE_COMMIT_TERMS): AutoRechargeCommitTerms {
  return { duration: { value: terms.duration.value, unit: terms.duration.unit }, rollover_fraction: terms.rolloverFraction, rate_type: terms.rateType };
}

export function buildSpendThresholdConfig(ctx: Ctx, enabled = true, thresholdEur = ctx.ids.spend_threshold?.scale_threshold_eur ?? SPEND_THRESHOLD.scaleThreshold) {
  return {
    is_enabled: enabled,
    threshold_amount: amt(ctx, thresholdEur),
    commit: { product_id: ctx.ids.products.fixed.spend_threshold, name: "Early usage charge", priority: PRIORITIES.spendThreshold },
    payment_gate_config: STRIPE_PAYMENT_INTENT_GATE,
  } satisfies Metronome.V1.ContractCreateParams["spend_threshold_configuration"];
}

/** Rate-card list price per product unit (tokens are priced per 1M in the rate card, images per image). */
const RATE_CARD_UNIT_PRICE: Record<MetricId, number> = {
  input_tokens: METRICS.input_tokens.pricePerUnit * 1_000_000,
  output_tokens: METRICS.output_tokens.pricePerUnit * 1_000_000,
  images: METRICS.images.pricePerUnit,
};
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * "Guarantee zero overages" overrides (= buildZeroOverageOverrides of the setup), for the Free plan. The contract's usage
 * list price is set to €0 with a MULTIPLIER 0 on the usage tag, and the real price is restored with commit-specific
 * OVERWRITE overrides that only apply while usage draws down a commit/credit (plan credits, bundles, promos).
 * With balance: charged at the real price against credits; without: the usage line is €0, never overage.
 * https://docs.metronome.com/guides/pricing-packaging/apply-credits-and-commits/guarantee-zero-overages
 */
export function buildZeroOverageOverrides(ctx: Ctx, plan: PlanId, startingAt: string) {
  const mult = round2(1 - PLANS[plan].discount);
  return [
    { starting_at: startingAt, type: "MULTIPLIER" as const, multiplier: 0, applicable_product_tags: [USAGE_TAG] },
    ...(Object.keys(RATE_CARD_UNIT_PRICE) as MetricId[]).map(k => ({
      starting_at: startingAt,
      type: "OVERWRITE" as const,
      is_commit_specific: true,
      overwrite_rate: { rate_type: "FLAT" as const, price: round6(RATE_CARD_UNIT_PRICE[k] * mult), credit_type_id: ctx.ids.credit_types.EUR },
      override_specifiers: [{ product_id: ctx.ids.products.usage[k] }],
    })),
  ];
}

/** Cuerpo exacto de POST /v1/contracts/create para un plan (= buildPlanContractBody del setup). */
export function buildPlanContractBody(ctx: Ctx, o: PlanContractOptions): Metronome.V1.ContractCreateParams {
  const plan = PLANS[o.plan];
  const eurId = ctx.ids.credit_types.EUR;
  const startingAt = o.startingAt ?? floorToHour();
  if (o.autoRecharge && !plan.autoRechargeAllowed) throw new Error(`Auto-recharge is not available on ${plan.name}`);
  if (o.spendThreshold && o.plan !== "scale") throw new Error("spend_threshold_configuration is only offered on Scale");
  if (o.spendThreshold && o.autoRecharge) throw new Error("Use auto-recharge (prepaid) OR spend threshold (early overage charge), not both on the same contract");
  const multiplier = round2(1 - plan.discount);
  return {
    customer_id: o.customerId,
    rate_card_id: ctx.ids.rate_card.id,
    name: `nebula ${plan.name}`,
    starting_at: startingAt,
    uniqueness_key: o.uniquenessKey ?? `nebula-${o.customerId}-${o.plan}-${startingAt}`.slice(0, 128),
    billing_provider_configuration: { billing_provider: "stripe", delivery_method: "direct_to_billing_provider" },
    usage_statement_schedule: o.billingAnchorDate
      ? { frequency: "MONTHLY", day: "CUSTOM_DATE", billing_anchor_date: o.billingAnchorDate }
      : { frequency: "MONTHLY", day: "CONTRACT_START" },
    custom_fields: { nebula_plan: o.plan },
    recurring_credits: [
      {
        name: `${plan.name} credits`,
        product_id: ctx.ids.products.fixed.plan_credits,
        access_amount: { credit_type_id: eurId, unit_price: amt(ctx, plan.monthlyCredits), quantity: 1 },
        commit_duration: { value: 1, unit: "PERIODS" },
        priority: PRIORITIES.planCredits,
        starting_at: startingAt,
        applicable_product_tags: [USAGE_TAG],
        rollover_fraction: 1,
      },
    ],
    ...(o.plan !== "free"
      ? {
          subscriptions: [
            {
              subscription_rate: { product_id: ctx.ids.products.subscription[o.plan as SubscriptionPlanKey], billing_frequency: "MONTHLY" as const },
              collection_schedule: "ADVANCE" as const,
              proration: { is_prorated: true, invoice_behavior: "BILL_IMMEDIATELY" as const },
              initial_quantity: 1,
              quantity_management_mode: "QUANTITY_ONLY" as const,
              starting_at: startingAt,
            },
          ],
        }
      : {}),
    ...(plan.zeroOverageGuarantee
      ? { overrides: buildZeroOverageOverrides(ctx, o.plan, startingAt) }
      : multiplier < 1 ? { overrides: [{ starting_at: startingAt, type: "MULTIPLIER" as const, multiplier, applicable_product_tags: [USAGE_TAG] }] } : {}),
    ...(o.autoRecharge ? { prepaid_balance_threshold_configuration: buildPrepaidBalanceThresholdConfig(ctx) } : {}),
    ...(o.spendThreshold ? { spend_threshold_configuration: buildSpendThresholdConfig(ctx) } : {}),
    ...(o.fromContractId ? { transition: { type: "RENEWAL" as const, from_contract_id: o.fromContractId } } : {}),
  };
}

/** 409 (uniqueness_key ya usada) ⇒ el contrato ya existe: se busca y se devuelve (reintento idempotente). */
export async function createPlanContract(ctx: Ctx, o: PlanContractOptions): Promise<string> {
  const body = buildPlanContractBody(ctx, o);
  try {
    return (await ctx.client.v1.contracts.create(body)).data.id;
  } catch (e) {
    if (!isConflict(e)) throw e;
    const list = await ctx.client.v2.contracts.list({ customer_id: o.customerId, starting_at: body.starting_at });
    const found = (list.data as unknown as ContractV2[]).find(c => c.uniqueness_key === body.uniqueness_key || (c.starting_at === body.starting_at && c.custom_fields?.nebula_plan === o.plan));
    if (!found) throw e;
    return found.id;
  }
}

export type ContractV2 = {
  id: string; customer_id: string; starting_at: string; ending_before?: string | null; archived_at?: string | null; uniqueness_key?: string | null;
  custom_fields?: Record<string, string>;
  usage_statement_schedule?: { frequency: string; billing_anchor_date: string };
  prepaid_balance_threshold_configuration?: { is_enabled: boolean; threshold_amount: number; recharge_to_amount: number; commit?: { duration?: { value: string | number; unit: string }; rollover_fraction?: number; rate_type?: string } } | null;
  spend_threshold_configuration?: { is_enabled: boolean; threshold_amount: number; payment_gate_config?: { payment_gate_type: string } } | null;
};

export async function getContract(ctx: Ctx, customerId: string, contractId: string, includeBalance = false): Promise<ContractV2> {
  const res = await ctx.client.v2.contracts.retrieve({ customer_id: customerId, contract_id: contractId, include_balance: includeBalance });
  return res.data as unknown as ContractV2;
}

export async function getActiveContract(ctx: Ctx, customerId: string, at = new Date().toISOString()): Promise<ContractV2 | undefined> {
  const res = await ctx.client.v2.contracts.list({ customer_id: customerId, covering_date: at });
  return (res.data as unknown as ContractV2[]).filter(c => !c.archived_at).sort((a, b) => b.starting_at.localeCompare(a.starting_at))[0];
}

export function summarizeContract(c: ContractV2, scale = 1): PlanContractSummary {
  const plan = (c.custom_fields?.nebula_plan as PlanContractSummary["plan"]) ?? "unknown";
  const pb = c.prepaid_balance_threshold_configuration;
  const st = c.spend_threshold_configuration;
  return {
    contractId: c.id, customerId: c.customer_id, plan, startingAt: c.starting_at, endingBefore: c.ending_before ?? undefined,
    billingAnchorDate: c.usage_statement_schedule?.billing_anchor_date,
    autoRecharge: pb
      ? ({
          enabled: pb.is_enabled, thresholdEur: pb.threshold_amount / scale, rechargeToEur: pb.recharge_to_amount / scale,
          commitDuration: pb.commit?.duration ? { value: Number(pb.commit.duration.value), unit: pb.commit.duration.unit as NonNullable<AutoRechargeState["commitDuration"]>["unit"] } : undefined,
          rolloverFraction: pb.commit?.rollover_fraction,
          rateType: pb.commit?.rate_type as AutoRechargeState["rateType"],
        } satisfies AutoRechargeState)
      : undefined,
    spendThreshold: st ? ({ enabled: st.is_enabled, thresholdEur: st.threshold_amount / scale, paymentGate: (st.payment_gate_config?.payment_gate_type ?? "NONE") as SpendThresholdState["paymentGate"] } satisfies SpendThresholdState) : undefined,
  };
}

export function nextPeriodStart(anchorIso: string, now = new Date()): string {
  const anchor = new Date(anchorIso);
  const d = new Date(anchor);
  let i = 0;
  while (d <= now && i < 1200) { i++; d.setTime(anchor.getTime()); d.setUTCMonth(anchor.getUTCMonth() + i); }
  return d.toISOString();
}

/** Subida: transición RENEWAL inmediata (prorrateo). Bajada: transición al inicio del siguiente periodo. */
/**
 * upgradeStart (= setup): "floor" starts the new plan at the current full hour, so usage already ingested in that hour is
 * re-rated with the new plan (seen live by the expert). "next_hour" starts at the next full hour: nothing from the old
 * plan is re-rated, but the change takes up to 59 min to apply in Metronome. Downgrades always start next period.
 */
export function upgradeStartAt(mode: "floor" | "next_hour", now = new Date()) {
  const floor = floorToHour(now);
  return mode === "next_hour" ? new Date(new Date(floor).getTime() + 3600_000).toISOString() : floor;
}
// ───────────────────────────── manual balance entries ─────────────────────────────

/**
 * Deterministic uniqueness key for a manual balance entry, in the same scheme as the rest of the adapter
 * (nebula-bundle-<purchaseId>, nebula-promo-<customer>-<code>, nebula-signup-<customer>): one key per business
 * operation id, so a retry (double click, timeout, webhook redelivery) can never apply the same adjustment twice.
 */
export function manualBalanceEntryKey(p: { customerId: string; balanceId: string; operationId: string }) {
  return `nebula-manual-${p.customerId}-${p.balanceId}-${p.operationId}`.slice(0, 128);
}

export type ManualBalanceEntryInput = {
  customerId: string; contractId?: string; balanceId: string; segmentId: string;
  amountEur: number; reason: string; operationId: string; timestamp?: string;
};

export function buildManualBalanceEntry(ctx: Ctx, p: ManualBalanceEntryInput) {
  return {
    customer_id: p.customerId,
    ...(p.contractId ? { contract_id: p.contractId } : {}),
    id: p.balanceId,
    segment_id: p.segmentId,
    amount: amt(ctx, p.amountEur),
    reason: p.reason,
    ...(p.timestamp ? { timestamp: p.timestamp } : {}),
    uniqueness_key: manualBalanceEntryKey({ customerId: p.customerId, balanceId: p.balanceId, operationId: p.operationId }),
  };
}

/**
 * POST /v1/contracts/addManualBalanceLedgerEntry. `uniqueness_key` is accepted by the API since 2026-08-18 but is not in
 * the @metronome/sdk 3.10.0 typings, so it is passed through this single narrow cast (the SDK sends the body as is).
 * 409 = this operation id was already applied → treated as success (idempotent retry).
 */
export async function addManualBalanceEntry(ctx: Ctx, p: ManualBalanceEntryInput): Promise<{ applied: boolean; uniquenessKey: string }> {
  const body = buildManualBalanceEntry(ctx, p);
  try {
    await ctx.client.v1.contracts.addManualBalanceEntry(body as Metronome.V1.ContractAddManualBalanceEntryParams & { uniqueness_key: string });
    return { applied: true, uniquenessKey: body.uniqueness_key };
  } catch (e) {
    if (isConflict(e)) return { applied: false, uniquenessKey: body.uniqueness_key };
    throw e;
  }
}

/** Archive a Metronome customer, only if its Metronome name starts with "Nebula demo" (never touches other customers). */
export async function archiveDemoCustomer(ctx: Ctx, customerId: string) {
  const c = (await ctx.client.v1.customers.retrieve({ customer_id: customerId })).data;
  if (!isArchivableDemoCustomer(c.name)) throw new Error(`Refusing to archive "${c.name}": only customers named "${DEMO_CUSTOMER_PREFIX} …" can be archived here.`);
  await ctx.client.v1.customers.archive({ id: customerId });
  return c.name;
}

export async function changePlan(ctx: Ctx, customerId: string, newPlan: PlanId, opts: { now?: Date; upgradeStart?: "floor" | "next_hour" } = {}): Promise<PlanChangeResult> {
  const current = await getActiveContract(ctx, customerId);
  if (!current) throw new Error(`Customer ${customerId} has no active contract`);
  const summary = summarizeContract(current);
  const currentPlan = summary.plan in PLANS ? (summary.plan as PlanId) : undefined;
  if (currentPlan === newPlan) return { kind: "same", fromContractId: current.id, effectiveAt: new Date().toISOString() };
  const isUpgrade = !currentPlan || PLANS[newPlan].rank > PLANS[currentPlan].rank;
  const anchor = summary.billingAnchorDate ?? current.starting_at;
  const startingAt = isUpgrade ? upgradeStartAt(opts.upgradeStart ?? "floor", opts.now) : nextPeriodStart(anchor, opts.now);
  const keepAutoRecharge = !!summary.autoRecharge?.enabled && PLANS[newPlan].autoRechargeAllowed;
  // Web: Scale lleva el cobro anticipado por umbral salvo que tenga recarga automática (el setup solo lo conserva si ya estaba).
  const keepSpendThreshold = newPlan === "scale" && !keepAutoRecharge;
  // La API rechaza threshold billing en contratos que aún no han empezado (400 "Threshold billing cannot be configured on a
  // contract that has not started yet"): bajadas y subidas next_hour se crean sin él y se añade con finishPendingThresholdConfig.
  const startsNow = new Date(startingAt).getTime() <= (opts.now ?? new Date()).getTime();
  const newContractId = await createPlanContract(ctx, {
    customerId, plan: newPlan, startingAt, billingAnchorDate: anchor, fromContractId: current.id,
    autoRecharge: keepAutoRecharge && startsNow, spendThreshold: keepSpendThreshold && startsNow,
  });
  const pendingThresholdConfig = startsNow ? undefined : keepAutoRecharge ? "auto_recharge" : keepSpendThreshold ? "spend_threshold" : undefined;
  return { kind: isUpgrade ? "upgrade" : "downgrade", fromContractId: current.id, newContractId, effectiveAt: startingAt, ...(pendingThresholdConfig ? { pendingThresholdConfig } : {}) };
}

/**
 * Completa un cambio de plan con `pendingThresholdConfig` cuando el contrato nuevo ya ha empezado. Idempotente: si la
 * configuración ya existe no hace nada. Ojo: añadirla con is_enabled=true evalúa el saldo en el acto y puede cobrar.
 */
export async function finishPendingThresholdConfig(ctx: Ctx, customerId: string, change: Pick<PlanChangeResult, "newContractId" | "effectiveAt" | "pendingThresholdConfig">, now = new Date()) {
  if (!change.pendingThresholdConfig || !change.newContractId) return { done: true as const, applied: false };
  if (new Date(change.effectiveAt).getTime() > now.getTime()) return { done: false as const, applied: false, retryAt: change.effectiveAt };
  const c = await getContract(ctx, customerId, change.newContractId);
  const key = change.pendingThresholdConfig === "auto_recharge" ? "prepaid_balance_threshold_configuration" : "spend_threshold_configuration";
  if (c[key]) return { done: true as const, applied: false };
  const body: Metronome.V2.ContractEditParams = change.pendingThresholdConfig === "auto_recharge"
    ? { customer_id: customerId, contract_id: change.newContractId, add_prepaid_balance_threshold_configuration: buildPrepaidBalanceThresholdConfig(ctx, true) }
    : { customer_id: customerId, contract_id: change.newContractId, add_spend_threshold_configuration: buildSpendThresholdConfig(ctx, true) };
  await ctx.client.v2.contracts.edit(body);
  return { done: true as const, applied: true };
}

// ───────────────────────────── bundles.ts ─────────────────────────────

export function buildBundleCommitEdit(ctx: Ctx, p: { customerId: string; contractId: string; bundle: BundleId; purchaseId: string; now?: Date }): Metronome.V2.ContractEditParams {
  const b = BUNDLES[p.bundle];
  const eurId = ctx.ids.credit_types.EUR;
  const start = floorToHour(p.now);
  return {
    customer_id: p.customerId,
    contract_id: p.contractId,
    uniqueness_key: `nebula-bundle-${p.purchaseId}`.slice(0, 128),
    add_commits: [
      {
        type: "PREPAID",
        name: `Bundle €${b.price}`,
        product_id: ctx.ids.products.fixed.bundle_commit,
        access_schedule: { credit_type_id: eurId, schedule_items: [{ amount: amt(ctx, b.price), starting_at: start, ending_before: addMonths(start, b.validityMonths) }] },
        invoice_schedule: { credit_type_id: eurId, schedule_items: [{ amount: amt(ctx, b.price), timestamp: start }] },
        payment_gate_config: STRIPE_PAYMENT_INTENT_GATE,
        priority: PRIORITIES.bundleCommit,
        applicable_product_tags: [USAGE_TAG],
        rollover_fraction: 1,
        custom_fields: { nebula_purchase_id: p.purchaseId, nebula_bundle: p.bundle },
      },
    ],
  };
}

/** purchaseId OBLIGATORIO (en el setup es opcional con randomUUID): la web lo deriva de su id de petición. */
export async function buyBundle(ctx: Ctx, p: { customerId: string; contractId: string; bundle: BundleId; purchaseId: string }): Promise<BundlePurchaseResult> {
  let editId = "";
  try {
    editId = (await ctx.client.v2.contracts.edit(buildBundleCommitEdit(ctx, p))).data.id;
  } catch (e) {
    if (!isConflict(e)) throw e; // 409: esta compra ya se envió (reintento)
  }
  const b = BUNDLES[p.bundle];
  return { bundle: p.bundle, purchaseId: p.purchaseId, contractId: p.contractId, editId, paidEur: b.price, bonusEur: b.credit - b.price, status: "payment_pending" };
}

export function buildBundleBonusEdit(ctx: Ctx, p: { customerId: string; contractId: string; bundle: BundleId; purchaseId: string; now?: Date }): Metronome.V2.ContractEditParams {
  const b = BUNDLES[p.bundle];
  const start = floorToHour(p.now);
  const bonus = b.credit - b.price;
  return {
    customer_id: p.customerId,
    contract_id: p.contractId,
    uniqueness_key: `nebula-bonus-${p.purchaseId}`.slice(0, 128),
    add_credits: [
      {
        name: `Bundle bonus €${b.price} (+€${bonus})`,
        product_id: ctx.ids.products.fixed.bundle_bonus,
        access_schedule: { credit_type_id: ctx.ids.credit_types.EUR, schedule_items: [{ amount: amt(ctx, bonus), starting_at: start, ending_before: addMonths(start, b.validityMonths) }] },
        priority: PRIORITIES.bundleBonus,
        applicable_product_tags: [USAGE_TAG],
        rollover_fraction: 1,
        custom_fields: { nebula_purchase_id: p.purchaseId, nebula_bundle: p.bundle },
      },
    ],
  };
}

export async function grantBundleBonus(ctx: Ctx, p: { customerId: string; contractId: string; bundle: BundleId; purchaseId: string }) {
  try {
    return await ctx.client.v2.contracts.edit(buildBundleBonusEdit(ctx, p));
  } catch (e) {
    if (isConflict(e)) return null; // ya concedido (webhook duplicado)
    throw e;
  }
}

/** Busca el commit de una compra por custom field nebula_purchase_id (confirma que el pago liberó el commit). */
export async function findBundleCommit(ctx: Ctx, customerId: string, purchaseId: string) {
  for await (const x of ctx.client.v1.contracts.listBalances({ customer_id: customerId, include_contract_balances: true, include_balance: true, limit: BALANCES_PAGE_LIMIT })) {
    const r = x as unknown as { id: string; type: string; custom_fields?: Record<string, string>; contract?: { id: string } };
    if (r.type === "PREPAID" && r.custom_fields?.nebula_purchase_id === purchaseId) return r;
  }
  return undefined;
}

// ───────────────────────────── thresholds.ts ─────────────────────────────

export async function buildAutoRechargeEdit(ctx: Ctx, customerId: string, contractId: string, enabled: boolean): Promise<Metronome.V2.ContractEditParams | undefined> {
  const c = await getContract(ctx, customerId, contractId);
  const s = summarizeContract(c);
  if (enabled && s.plan in PLANS && !PLANS[s.plan as PlanId].autoRechargeAllowed) throw new Error(AUTO_RECHARGE_PLANS_ERROR);
  if (enabled && s.spendThreshold?.enabled) throw new Error("Turn off the early threshold charge first (they can't be combined)");
  if (!c.prepaid_balance_threshold_configuration) {
    if (!enabled) return undefined;
    return { customer_id: customerId, contract_id: contractId, add_prepaid_balance_threshold_configuration: buildPrepaidBalanceThresholdConfig(ctx, true) };
  }
  return {
    customer_id: customerId,
    contract_id: contractId,
    update_prepaid_balance_threshold_configuration: enabled
      ? ({ is_enabled: true, threshold_amount: amt(ctx, ctx.ids.auto_recharge.threshold_eur), recharge_to_amount: amt(ctx, ctx.ids.auto_recharge.recharge_to_eur), commit: buildAutoRechargeCommitTerms() } as Metronome.V2.ContractEditParams.UpdatePrepaidBalanceThresholdConfiguration)
      : { is_enabled: false },
  };
}

/** Solo sincroniza las condiciones del commit de recarga (sin tocar is_enabled). undefined si no hay config o ya están al día. */
export async function buildAutoRechargeCommitTermsEdit(ctx: Ctx, customerId: string, contractId: string): Promise<Metronome.V2.ContractEditParams | undefined> {
  const c = await getContract(ctx, customerId, contractId);
  const pb = c.prepaid_balance_threshold_configuration;
  if (!pb) return undefined;
  const want = buildAutoRechargeCommitTerms();
  const cur = pb.commit ?? {};
  const upToDate = Number(cur.duration?.value) === want.duration.value && cur.duration?.unit === want.duration.unit && cur.rollover_fraction === want.rollover_fraction && cur.rate_type === want.rate_type;
  if (upToDate) return undefined;
  return { customer_id: customerId, contract_id: contractId, update_prepaid_balance_threshold_configuration: { commit: want } as Metronome.V2.ContractEditParams.UpdatePrepaidBalanceThresholdConfiguration };
}

export async function syncAutoRechargeCommitTerms(ctx: Ctx, customerId: string, contractId: string) {
  const body = await buildAutoRechargeCommitTermsEdit(ctx, customerId, contractId);
  return body ? ctx.client.v2.contracts.edit(body) : undefined;
}

export async function setAutoRecharge(ctx: Ctx, customerId: string, contractId: string, enabled: boolean) {
  const body = await buildAutoRechargeEdit(ctx, customerId, contractId, enabled);
  return body ? ctx.client.v2.contracts.edit(body) : undefined;
}

export async function buildSpendThresholdEdit(ctx: Ctx, customerId: string, contractId: string, enabled: boolean, thresholdEur = ctx.ids.spend_threshold.scale_threshold_eur): Promise<Metronome.V2.ContractEditParams | undefined> {
  const c = await getContract(ctx, customerId, contractId);
  const s = summarizeContract(c);
  if (enabled && s.plan !== "scale") throw new Error("The early threshold charge is only available on Scale");
  if (enabled && s.autoRecharge?.enabled) throw new Error("Turn off auto-recharge first (they can't be combined)");
  if (!c.spend_threshold_configuration) {
    if (!enabled) return undefined;
    return { customer_id: customerId, contract_id: contractId, add_spend_threshold_configuration: buildSpendThresholdConfig(ctx, true, thresholdEur) };
  }
  return {
    customer_id: customerId,
    contract_id: contractId,
    update_spend_threshold_configuration: enabled ? { is_enabled: true, threshold_amount: amt(ctx, thresholdEur) } : { is_enabled: false },
  };
}

export async function setSpendThreshold(ctx: Ctx, customerId: string, contractId: string, enabled: boolean, thresholdEur?: number) {
  const body = await buildSpendThresholdEdit(ctx, customerId, contractId, enabled, thresholdEur);
  return body ? ctx.client.v2.contracts.edit(body) : undefined;
}

// ───────────────────────────── notifications.ts ─────────────────────────────

export const ALERT_TYPE_BALANCE = "low_remaining_contract_credit_and_commit_balance_reached" as const;
export const lowBalanceThresholdEur = (plan: PlanId) => round2(PLANS[plan].monthlyCredits * LOW_BALANCE_RATIO);

export function buildLowBalanceAlertBody(ctx: Ctx, customerId: string, plan: PlanId): Metronome.V1.AlertCreateParams {
  return {
    alert_type: ALERT_TYPE_BALANCE,
    name: `nebula · low balance ${Math.round(LOW_BALANCE_RATIO * 100)}% (${PLANS[plan].name})`,
    threshold: amt(ctx, lowBalanceThresholdEur(plan)),
    credit_type_id: ctx.ids.credit_types.EUR,
    customer_id: customerId,
    uniqueness_key: `nebula-low-${customerId}-${plan}`,
    evaluate_on_create: true,
  };
}

export async function listCustomerAlerts(ctx: Ctx, customerId: string) {
  const rows: { alert: { id: string; uniqueness_key?: string | null } }[] = [];
  for await (const r of ctx.client.v1.customers.alerts.list({ customer_id: customerId })) rows.push(r as unknown as (typeof rows)[number]);
  return rows;
}

/** Deja al cliente con exactamente una alerta del 20 % para su plan actual: archiva las de otros planes (idempotente). */
export async function syncPlanLowBalanceAlert(ctx: Ctx, customerId: string, plan: PlanId): Promise<{ id?: string; archived: string[] }> {
  const want = buildLowBalanceAlertBody(ctx, customerId, plan);
  const archived: string[] = [];
  let keepId: string | undefined;
  for (const a of await listCustomerAlerts(ctx, customerId)) {
    const key = a.alert.uniqueness_key ?? "";
    if (!key.startsWith(`nebula-low-${customerId}-`)) continue; // no tocar la global ni otras
    if (key === want.uniqueness_key) keepId = a.alert.id;
    else { await ctx.client.v1.alerts.archive({ id: a.alert.id, release_uniqueness_key: true }); archived.push(a.alert.id); }
  }
  if (keepId) return { id: keepId, archived };
  try {
    return { id: (await ctx.client.v1.alerts.create(want)).data.id, archived };
  } catch (e) {
    if (isConflict(e)) return { archived };
    throw e;
  }
}

// ───────────────────────────── billing.ts ─────────────────────────────

function grantKind(ctx: Ctx, productId: string): GrantKind {
  const map: Record<string, GrantKind> = { plan_credits: "plan_credit", bundle_commit: "bundle_commit", bundle_bonus: "bundle_bonus", promo_credit: "promo", auto_recharge: "auto_recharge", spend_threshold: "spend_threshold", enterprise_commit: "enterprise_commit" };
  for (const [k, id] of Object.entries(ctx.ids.products.fixed)) if (id === productId) return map[k] ?? "other";
  return "other";
}

export async function getNetBalanceEur(ctx: Ctx, customerId: string): Promise<number> {
  const res = await ctx.client.v1.contracts.getNetBalance({ customer_id: customerId, credit_type_id: ctx.ids.credit_types.EUR });
  return fromAmt(ctx, res.data.balance);
}

type RawBalance = {
  id: string; type: "PREPAID" | "POSTPAID" | "CREDIT"; name?: string; product: { id: string; name?: string }; contract?: { id: string };
  access_schedule?: { schedule_items: { amount: number; starting_at: string; ending_before: string }[] }; balance?: number; custom_fields?: Record<string, string>;
};

export function toGrantView(ctx: Ctx, r: RawBalance, now = new Date().toISOString()): CreditGrantView {
  const items = r.access_schedule?.schedule_items ?? [];
  const current = items.find(i => i.starting_at <= now && now < i.ending_before) ?? items[items.length - 1];
  return {
    id: r.id, kind: grantKind(ctx, r.product.id), metronomeType: r.type, name: r.name ?? r.product.name ?? "", productId: r.product.id,
    grantedEur: fromAmt(ctx, current?.amount), remainingEur: fromAmt(ctx, r.balance), startsAt: current?.starting_at, expiresAt: current?.ending_before,
    contractId: r.contract?.id, reference: r.custom_fields?.nebula_promo ?? r.custom_fields?.nebula_purchase_id,
  };
}

export async function getBalanceSummary(ctx: Ctx, customerId: string): Promise<BalanceSummary> {
  const now = new Date().toISOString();
  const grants: CreditGrantView[] = [];
  for await (const r of ctx.client.v1.contracts.listBalances({ customer_id: customerId, covering_date: now, include_contract_balances: true, include_balance: true, exclude_zero_balances: false, limit: BALANCES_PAGE_LIMIT })) {
    grants.push(toGrantView(ctx, r as unknown as RawBalance, now));
  }
  return { customerId, currency: "EUR", netBalanceEur: await getNetBalanceEur(ctx, customerId), grants, asOf: now };
}

type RawLine = { name: string; type: string; quantity?: number; unit_price?: number; total: number; product_id?: string; is_prorated?: boolean; starting_at?: string; ending_before?: string; applied_commit_or_credit?: { id: string } };
type RawInvoice = {
  id: string; status: string; type: string; contract_id?: string; issued_at?: string; start_timestamp?: string; end_timestamp?: string;
  total: number; credit_type: { id: string; name: string }; line_items: RawLine[];
  /** "billable" | "unbillable" (typed `unknown` in SDK 3.10.0: availability depends on the account configuration). */
  billable_status?: unknown;
  external_invoice?: { invoice_id?: string; external_status?: string; pdf_url?: string; billing_provider_error?: string } | null;
};

export function toInvoiceView(i: RawInvoice, scale = 1): InvoiceView {
  return {
    id: i.id, status: i.status, type: i.type, contractId: i.contract_id, issuedAt: i.issued_at, periodStart: i.start_timestamp, periodEnd: i.end_timestamp,
    totalEur: round2(i.total / scale), currency: i.credit_type?.name ?? "EUR",
    lines: (i.line_items ?? []).map(l => ({
      name: l.name, type: l.type, quantity: l.quantity, unitPriceEur: l.unit_price === undefined ? undefined : l.unit_price / scale, totalEur: round2(l.total / scale),
      productId: l.product_id, isProrated: l.is_prorated, appliedCommitOrCreditId: l.applied_commit_or_credit?.id, startingAt: l.starting_at, endingBefore: l.ending_before,
    })),
    stripeInvoiceId: i.external_invoice?.invoice_id ?? undefined, stripeStatus: i.external_invoice?.external_status ?? undefined, stripeError: i.external_invoice?.billing_provider_error ?? undefined, billableStatus: typeof i.billable_status === "string" ? i.billable_status : undefined, pdfUrl: i.external_invoice?.pdf_url ?? undefined,
  };
}

export async function listInvoices(ctx: Ctx, customerId: string, q: { status?: "DRAFT" | "FINALIZED" | "VOID"; limit?: number } = {}): Promise<InvoiceView[]> {
  const out: InvoiceView[] = [];
  const page = await ctx.client.v1.customers.invoices.list({ customer_id: customerId, status: q.status, limit: q.limit ?? 25, sort: "date_desc", skip_zero_qty_line_items: true, credit_type_id: ctx.ids.credit_types.EUR });
  for (const i of page.data) out.push(toInvoiceView(i as unknown as RawInvoice, ctx.ids.amount_scale || 1));
  return out;
}

export async function getInvoice(ctx: Ctx, customerId: string, invoiceId: string): Promise<InvoiceView> {
  const res = await ctx.client.v1.customers.invoices.retrieve({ customer_id: customerId, invoice_id: invoiceId, skip_zero_qty_line_items: true });
  return toInvoiceView(res.data as unknown as RawInvoice, ctx.ids.amount_scale || 1);
}

/** Pura: agrega las facturas DRAFT de tipo USAGE cuyo periodo cubre "ahora" (misma lógica que el setup). */
export function previewFromDrafts(customerId: string, drafts0: InvoiceView[], contractId?: string, nowIso = new Date().toISOString()): UpcomingInvoicePreview {
  const drafts = drafts0.filter(d => d.status === "DRAFT" && d.type === "USAGE" && (!d.periodStart || d.periodStart <= nowIso) && (!d.periodEnd || nowIso < d.periodEnd));
  const lines = drafts.flatMap(d => d.lines);
  const gross = lines.filter(l => l.type === "usage" || l.type === "subscription").reduce((s, l) => s + l.totalEur, 0);
  const applied = lines.filter(l => l.type === "applied_commit_or_credit").reduce((s, l) => s + Math.abs(l.totalEur), 0);
  const starts = drafts.map(d => d.periodStart).filter(Boolean) as string[];
  const ends = drafts.map(d => d.periodEnd).filter(Boolean) as string[];
  return {
    customerId, contractId, periodStart: starts.sort()[0], periodEnd: ends.sort().at(-1),
    grossChargesEur: round2(gross), creditsAppliedEur: round2(applied), totalDueEur: round2(drafts.reduce((s, d) => s + d.totalEur, 0)),
    lines, draftInvoiceIds: drafts.map(d => d.id), asOf: nowIso,
  };
}

export async function getUpcomingInvoicePreview(ctx: Ctx, customerId: string, contractId?: string): Promise<UpcomingInvoicePreview> {
  const page = await ctx.client.v1.customers.invoices.list({ customer_id: customerId, status: "DRAFT", contract_id: contractId, skip_zero_qty_line_items: true, credit_type_id: ctx.ids.credit_types.EUR, limit: 100 });
  const views = page.data.map(i => toInvoiceView(i as unknown as RawInvoice, ctx.ids.amount_scale || 1));
  return previewFromDrafts(customerId, views, contractId);
}

// ───────────────────────────── usage.ts ─────────────────────────────

export type IngestEvent = Metronome.V1.UsageIngestParams.Usage;

export function llmRequestEvent(ctx: Ctx, p: { transactionId: string; customer: string; inputTokens: number; outputTokens: number; model: string; timestamp?: string }): IngestEvent {
  return {
    transaction_id: p.transactionId, customer_id: p.customer, event_type: ctx.ids.event_types.input_tokens, timestamp: p.timestamp ?? new Date().toISOString(),
    properties: { [ctx.ids.event_properties.input_tokens]: p.inputTokens, [ctx.ids.event_properties.output_tokens]: p.outputTokens, model: p.model },
  };
}

export function imageGenerationEvent(ctx: Ctx, p: { transactionId: string; customer: string; images: number; model: string; timestamp?: string }): IngestEvent {
  return { transaction_id: p.transactionId, customer_id: p.customer, event_type: ctx.ids.event_types.images, timestamp: p.timestamp ?? new Date().toISOString(), properties: { [ctx.ids.event_properties.images]: p.images, model: p.model } };
}

export async function ingest(ctx: Ctx, events: IngestEvent[]) {
  for (let i = 0; i < events.length; i += 100) await ctx.client.v1.usage.ingest({ usage: events.slice(i, i + 100) });
}

const midnightUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();

export function buildUsageLast30DaysBody(ctx: Ctx, customerId: string, now = new Date()): Metronome.V1.UsageListParams {
  const end = new Date(midnightUtc(now));
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return { customer_ids: [customerId], billable_metrics: Object.values(ctx.ids.billable_metrics).map(id => ({ id })), window_size: "DAY", starting_on: start.toISOString(), ending_before: end.toISOString() };
}

export async function getUsageLast30Days(ctx: Ctx, customerId: string, now = new Date()): Promise<UsageLast30Days> {
  const body = buildUsageLast30DaysBody(ctx, customerId, now);
  const rows: { billable_metric_id: string; start_timestamp: string; value: number | null }[] = [];
  for await (const r of ctx.client.v1.usage.list(body)) rows.push(r as unknown as (typeof rows)[number]);
  const metrics = {} as Record<MetricId, MetricUsage>;
  for (const [key, bmId] of Object.entries(ctx.ids.billable_metrics) as [MetricId, string][]) {
    const daily = rows.filter(r => r.billable_metric_id === bmId).map(r => ({ day: r.start_timestamp, value: r.value ?? 0 })).sort((a, b) => a.day.localeCompare(b.day));
    const total = daily.reduce((s, d) => s + d.value, 0);
    metrics[key] = { metric: key, billableMetricId: bmId, total, daily, listCostEur: round2(total * METRICS[key].pricePerUnit) };
  }
  return { customerId, windowStart: body.starting_on, windowEnd: body.ending_before, metrics, totalListCostEur: round2(Object.values(metrics).reduce((s, m) => s + m.listCostEur, 0)) };
}

// ───────────────────────────── promotions.ts ─────────────────────────────

export function buildPromoCreditEdit(ctx: Ctx, p: { customerId: string; contractId: string; code: string; label: string; amountEur: number; validDays: number; now?: Date }): Metronome.V2.ContractEditParams {
  const code = p.code.toUpperCase();
  const start = floorToHour(p.now);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + p.validDays);
  return {
    customer_id: p.customerId,
    contract_id: p.contractId,
    uniqueness_key: `nebula-promo-${p.customerId}-${code}`.slice(0, 128),
    add_credits: [
      {
        name: `${p.label} (${code})`,
        product_id: ctx.ids.products.fixed.promo_credit,
        access_schedule: { credit_type_id: ctx.ids.credit_types.EUR, schedule_items: [{ amount: amt(ctx, p.amountEur), starting_at: start, ending_before: end.toISOString() }] },
        priority: PRIORITIES.promo,
        applicable_product_tags: [USAGE_TAG],
        rollover_fraction: 1,
        custom_fields: { nebula_promo: code },
      },
    ],
  };
}

export async function grantPromoCredit(ctx: Ctx, p: Parameters<typeof buildPromoCreditEdit>[1]): Promise<PromoCreditResult> {
  const body = buildPromoCreditEdit(ctx, p);
  try {
    const res = await ctx.client.v2.contracts.edit(body);
    const item = body.add_credits![0].access_schedule.schedule_items[0];
    return { code: p.code.toUpperCase(), label: body.add_credits![0].name!, amountEur: p.amountEur, startsAt: item.starting_at, expiresAt: item.ending_before, contractId: p.contractId, editId: res.data.id };
  } catch (e) {
    if (isConflict(e)) throw new Error(`You have already redeemed the code ${p.code.toUpperCase()}`);
    throw e;
  }
}

// ───────────────────────────── webhooks.ts ─────────────────────────────

/** Traduce un evento a la acción de negocio (= interpretWebhook del setup; importes divididos por amount_scale). */
export function interpretWebhook(evt: MetronomeWebhookEvent, scale = 1): WebhookAction {
  switch (evt.type) {
    case "alerts.low_remaining_contract_credit_and_commit_balance_reached": {
      const p = evt.properties as unknown as BalanceAlertProperties;
      if (p.threshold <= 0) return { action: "cut_access", customerId: p.customer_id };
      return { action: "offer_top_up", customerId: p.customer_id, remainingEur: p.remaining_balance / scale };
    }
    case "payment_gate.payment_status": {
      const p = evt.properties as unknown as PaymentGateProperties;
      if (p.payment_status === "paid") return { action: "payment_succeeded", customerId: p.customer_id, contractId: p.contract_id, invoiceId: p.invoice_id, workflowType: p.workflow_type };
      return { action: "payment_failed", customerId: p.customer_id, contractId: p.contract_id, message: p.error_message, workflowType: p.workflow_type };
    }
    case "payment_gate.payment_pending_action_required": {
      const p = evt.properties as unknown as PaymentGateProperties;
      return { action: "payment_requires_action", customerId: p.customer_id, contractId: p.contract_id, paymentIntentId: p.billing_provider?.stripe?.payment_intent_id };
    }
    case "payment_gate.threshold_reached": {
      const p = evt.properties as unknown as PaymentGateProperties;
      return { action: "threshold_charge_started", customerId: p.customer_id, contractId: p.contract_id, workflowType: p.workflow_type };
    }
    default:
      return { action: "ignore" };
  }
}

export type { InvoiceLineView };
