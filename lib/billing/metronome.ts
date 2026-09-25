// Adaptador real de Metronome (modo en vivo). Se activa con METRONOME_API_TOKEN + METRONOME_LIVE=1.
//
// Usa el SDK oficial @metronome/sdk (Stainless, tipado a partir del OpenAPI de Metronome), así que
// los cuerpos de las peticiones se comprueban en compilación contra la especificación oficial.
// Referencias:
//   - API: https://docs.metronome.com/api-reference/introduction   (OpenAPI: https://docs.metronome.com/openapi.json)
//   - Crear cliente:        POST /v1/customers                        https://docs.metronome.com/api-reference/customers/create-a-customer
//   - Crear contrato:       POST /v1/contracts/create                 https://docs.metronome.com/api-reference/contracts/create-a-contract
//   - Editar contrato:      POST /v2/contracts/edit                   https://docs.metronome.com/api-reference/contracts/edit-a-contract
//   - Cambio de plan:       POST /v1/contracts/create con transition  https://docs.metronome.com/guides/pricing-packaging/subscription/manage-subscription-lifecycle
//   - Leer contrato:        POST /v2/contracts/get                    https://docs.metronome.com/api-reference/contracts/get-a-contract-v2
//   - Saldos:               POST /v1/contracts/customerBalances/list  https://docs.metronome.com/api-reference/credits-and-commits/list-balances
//   - Facturas:             GET  /v1/customers/{id}/invoices[/{invoice_id}] https://docs.metronome.com/api-reference/invoices/list-invoices
//   - Ingesta:              POST /v1/ingest                           https://docs.metronome.com/api-reference/usage/ingest-events
//   - Alertas de saldo:     POST /v1/alerts/create                    https://docs.metronome.com/api-reference/alerts/create-a-threshold-notification
//   - Recarga automática:   prepaid_balance_threshold_configuration   https://docs.metronome.com/guides/customers-billing/optimize-customer-experience/prepaid-balance-thresholds
//   - Commits con pago:     payment_gate_config                       https://docs.metronome.com/guides/pricing-packaging/apply-credits-and-commits/manual-payment-gated-commits
//
// Importes: "USD es la única moneda en céntimos; EUR y el resto van en unidades enteras (10 € = 10)".
//   https://docs.metronome.com/guides/pricing-packaging/make-pricing-changes/use-currency-custompricingunits
//   Por eso money() multiplica por ids.amountScale (1 para EUR; 100 si alguien configura USD).
import Metronome from "@metronome/sdk";
import { randomUUID } from "node:crypto";
import { AUTO_RECHARGE, BUNDLES, LOW_BALANCE_RATIO, METRICS, PLANS, eur, type BundleId, type MetricId, type PlanId } from "../catalog";
import { addAlert, getAlerts, getLink, read, saveLink, tx, type CustomerLink } from "../store";
import { loadMetronomeIds, type MetronomeIds } from "./metronome-config";
import { round, usageCost } from "./mock";
import type { Account, Alert, BillingProvider, CreditGrant, DailyUsage, Invoice, InvoiceLine, SignupInput, UsageEvent } from "./types";

// Prioridades de consumo (menor = antes), alineadas con metronome-setup/src/config.ts (PRIORITIES).
// Metronome consume los prepagados por priority: https://docs.metronome.com/guides/pricing-packaging/apply-credits-and-commits/prioritization-rules
export const PRIORITY = { recurring: 1, gift: 5, commit: 10 } as const;

let _client: Metronome | null = null;
export const client = () => (_client ??= new Metronome({ bearerToken: process.env.METRONOME_API_TOKEN || process.env.METRONOME_API_KEY, webhookSecret: process.env.METRONOME_WEBHOOK_SECRET ?? null }));

let scale = 1; // = ids.amountScale; lo fijan idsNow() y los constructores de cuerpos
const idsNow = () => { const i = loadMetronomeIds(); scale = i.amountScale; return i; };
const money = (n: number) => Math.round(n * scale * 10000) / 10000;
const fromMoney = (n: number | undefined | null) => round((n ?? 0) / scale);
/** Los créditos y commits solo pagan uso (si no, también se comerían la cuota de suscripción). */
const usageOnly = (i: MetronomeIds) => Object.values(i.usageProducts);

/** Metronome exige marcas de tiempo alineadas a la hora en varias fechas de contrato. */
export const hourFloor = (d = new Date()) => { const x = new Date(d); x.setUTCMinutes(0, 0, 0); return x.toISOString(); };
// TODO(verificar): alineación exigida para starting_at de contratos/commits (hora vs. día).
//   La especificación menciona "must be on an hour boundary" en algunos campos: https://docs.metronome.com/openapi.json
export function utcMonth(d = new Date()) {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}
const plusYears = (iso: string, y: number) => { const d = new Date(iso); d.setUTCFullYear(d.getUTCFullYear() + y); return d.toISOString(); };

// ---------------------------------------------------------------------------
// Constructores de cuerpos (puros; se prueban en tests/metronome-bodies.test.ts)
// ---------------------------------------------------------------------------

export function buildCustomerBody(input: SignupInput & { appUserId: string }): Metronome.V1.CustomerCreateParams {
  if (!input.stripeCustomerId) throw new Error("Falta el cliente de Stripe: completa primero Stripe Checkout (modo setup).");
  return {
    name: input.name,
    // Alias de ingesta: permite enviar eventos con nuestro id de usuario en customer_id.
    ingest_aliases: [input.appUserId],
    customer_billing_provider_configurations: [
      {
        billing_provider: "stripe",
        delivery_method: "direct_to_billing_provider",
        // Stripe necesita un método de pago por defecto en invoice_settings para charge_automatically
        // (lo fijamos en /api/stripe/return): https://docs.metronome.com/integrations/invoice-integrations/stripe
        configuration: { stripe_customer_id: input.stripeCustomerId, stripe_collection_method: "charge_automatically" },
      },
    ],
  };
}

const overridesFor = (ids: MetronomeIds, plan: PlanId, startingAt: string): Metronome.V1.ContractCreateParams.Override[] =>
  PLANS[plan].discount > 0
    ? (Object.keys(METRICS) as MetricId[]).map(m => ({ starting_at: startingAt, type: "MULTIPLIER" as const, multiplier: round(1 - PLANS[plan].discount), product_id: ids.usageProducts[m] }))
    : [];

function subscriptionFor(ids: MetronomeIds, plan: PlanId, startingAt?: string) {
  const product = ids.subscriptionProducts[plan];
  if (PLANS[plan].monthlyFee <= 0) return [];
  if (!product) throw new Error(`Falta el producto de suscripción de Metronome para el plan ${PLANS[plan].name}`);
  return [{
    name: `Plan ${PLANS[plan].name}`,
    // El precio (29 € / 199 €) vive en la tarifa: product_id + billing_frequency deben existir en el rate card.
    subscription_rate: { product_id: product, billing_frequency: "MONTHLY" as const },
    collection_schedule: "ADVANCE" as const,
    // Prorrateo con cobro inmediato (BILL_IMMEDIATELY solo es válido con ADVANCE).
    proration: { is_prorated: true, invoice_behavior: "BILL_IMMEDIATELY" as const },
    initial_quantity: 1,
    ...(startingAt ? { starting_at: startingAt } : {}),
  }];
}

function recurringCreditFor(ids: MetronomeIds, plan: PlanId, startingAt: string) {
  const p = PLANS[plan];
  return {
    name: `Créditos mensuales ${p.name}`,
    product_id: ids.recurringCreditProduct,
    access_amount: { unit_price: money(p.monthlyCredits), quantity: 1, credit_type_id: ids.creditTypeId },
    priority: PRIORITY.recurring,
    applicable_product_ids: usageOnly(ids),
    commit_duration: { value: 1, unit: "PERIODS" as const }, // caducan cada mes: no se acumulan
    recurrence_frequency: "MONTHLY" as const,
    starting_at: startingAt,
    // proration por defecto (FIRST_AND_LAST): el primer mes parcial (alta o subida a mitad de ciclo) se prorratea,
    // igual que en metronome-setup. rollover_fraction = 1 solo actúa en transiciones de contrato.
    rollover_fraction: 1,
  };
}

export function buildContractBody(ids: MetronomeIds, args: { customerId: string; plan: PlanId; appUserId: string; startingAt: string; transitionFrom?: string; autoRecharge?: boolean }): Metronome.V1.ContractCreateParams {
  scale = ids.amountScale;
  const { customerId, plan, startingAt } = args;
  const common = {
    customer_id: customerId,
    starting_at: startingAt,
    uniqueness_key: `nebula-${args.appUserId}-${plan}-${startingAt}`,
    billing_provider_configuration: { billing_provider: "stripe" as const, delivery_method: "direct_to_billing_provider" as const },
    ...(args.transitionFrom ? { transition: { type: "RENEWAL" as const, from_contract_id: args.transitionFrom } } : {}),
  };
  const pkg = ids.packages[plan];
  if (pkg) {
    // Variante con plantillas de plan como "packages" (si el setup las crea).
    // TODO(verificar): qué campos admite create junto a package_id ("only customer_id, starting_at, package_id, uniqueness_key..."):
    //   https://docs.metronome.com/api-reference/contracts/create-a-contract
    return { customer_id: customerId, starting_at: startingAt, package_id: pkg, uniqueness_key: common.uniqueness_key, ...(args.transitionFrom ? { transition: common.transition } : {}) };
  }
  const subs = subscriptionFor(ids, plan);
  return {
    ...common,
    name: `nebula.ai · ${PLANS[plan].name}`,
    rate_card_id: ids.rateCardId,
    usage_statement_schedule: { frequency: "MONTHLY", day: "FIRST_OF_MONTH" },
    ...(subs.length ? { subscriptions: subs } : {}),
    recurring_credits: [recurringCreditFor(ids, plan, startingAt)],
    overrides: overridesFor(ids, plan, startingAt),
    multiplier_override_prioritization: "LOWEST_MULTIPLIER", // aplica siempre el mayor descuento vigente
    ...(ids.fromSetup ? { custom_fields: { nebula_plan: plan } } : {}),
    // Al cambiar de plan se conserva la recarga automática si el plan nuevo la permite.
    ...(args.autoRecharge && PLANS[plan].autoRechargeAllowed ? { prepaid_balance_threshold_configuration: thresholdConfig(ids) } : {}),
  };
}

export function buildBundleEdit(ids: MetronomeIds, args: { customerId: string; contractId: string; bundle: BundleId; now?: Date }): Metronome.V2.ContractEditParams {
  scale = ids.amountScale;
  const b = BUNDLES[args.bundle];
  const start = hourFloor(args.now);
  const ct = { credit_type_id: ids.creditTypeId };
  return {
    customer_id: args.customerId,
    contract_id: args.contractId,
    uniqueness_key: `bundle-${args.contractId}-${randomUUID()}`,
    add_commits: [{
      type: "PREPAID",
      name: `Commit prepagado ${eur(b.price)}`,
      product_id: ids.prepaidCommitProduct,
      priority: PRIORITY.commit,
      applicable_product_ids: usageOnly(ids),
      rollover_fraction: 1, // el saldo comprado sobrevive a los cambios de plan (transiciones)
      ...(ids.fromSetup ? { custom_fields: { nebula_bundle: args.bundle } } : {}),
      access_schedule: { ...ct, schedule_items: [{ amount: money(b.price), starting_at: start, ending_before: plusYears(start, 1) }] },
      invoice_schedule: { ...ct, schedule_items: [{ amount: money(b.price), timestamp: start }] },
      // Metronome cobra al momento en Stripe (PaymentIntent) y solo libera el saldo si el pago se completa.
      payment_gate_config: { payment_gate_type: "STRIPE", tax_type: "NONE", stripe_config: { payment_type: "PAYMENT_INTENT" } },
    }],
  };
}

export function buildGiftEdit(ids: MetronomeIds, args: { customerId: string; contractId: string; bundle: BundleId; now?: Date }): Metronome.V2.ContractEditParams | null {
  scale = ids.amountScale;
  const b = BUNDLES[args.bundle];
  const gift = b.credit - b.price;
  if (gift <= 0) return null;
  const start = hourFloor(args.now);
  return {
    customer_id: args.customerId,
    contract_id: args.contractId,
    uniqueness_key: `gift-${args.contractId}-${randomUUID()}`,
    add_credits: [{
      name: `Saldo de regalo (${eur(gift)})`,
      product_id: ids.giftCreditProduct,
      priority: PRIORITY.gift,
      applicable_product_ids: usageOnly(ids),
      rollover_fraction: 1,
      ...(ids.fromSetup ? { custom_fields: { nebula_bundle: args.bundle } } : {}),
      access_schedule: { credit_type_id: ids.creditTypeId, schedule_items: [{ amount: money(gift), starting_at: start, ending_before: plusYears(start, 1) }] },
    }],
  };
}

/** Recarga automática: "si el saldo baja de 10 €, recargar hasta 10 € + 50 €". */
export function thresholdConfig(ids: MetronomeIds) {
  scale = ids.amountScale;
  const b = BUNDLES[AUTO_RECHARGE.bundle];
  return {
    is_enabled: true,
    threshold_amount: money(AUTO_RECHARGE.threshold),
    // Metronome "recarga hasta" un saldo objetivo (no compra un bundle fijo): el commit creado es
    // recharge_to_amount - saldo actual. Mínimos documentados: umbral ≥ 5 y recharge_to ≥ umbral + 10.
    // Se toma de auto_recharge.recharge_to_eur del fichero de IDs (metronome-setup usa 50 → commit ≈ 40 €);
    // sin fichero, 60 € (≈ commit de 50 €, como el bundle del catálogo). También METRONOME_RECHARGE_TO_EUR.
    recharge_to_amount: money(ids.rechargeToAmount),
    commit: { product_id: ids.autoRechargeProduct, name: "Recarga automática", priority: PRIORITY.commit, applicable_product_ids: usageOnly(ids), rollover_fraction: 1 },
    payment_gate_config: { payment_gate_type: "STRIPE" as const, tax_type: "NONE" as const, stripe_config: { payment_type: "PAYMENT_INTENT" as const } },
    // El +10 % de regalo del bundle de 50 € se puede reproducir con discount_configuration (pagar 50/55 del saldo),
    // pero está tras un feature flag de Metronome ("ff:threshold-billing-discounts").
    // TODO(verificar) con Metronome que el flag está activo antes de poner threshold_discount=true.
    ...(ids.thresholdDiscount ? { discount_configuration: { payment_fraction: round(b.price / b.credit) } } : {}),
  };
}

export function buildIngestEvents(ids: MetronomeIds, customerKey: string, events: { metric: MetricId; quantity: number; ts?: string }[]): Metronome.V1.UsageIngestParams.Usage[] {
  // Un evento por event_type (por defecto: nebula_llm_request con input/output tokens y
  // nebula_image_generation con images), como define metronome-setup/src/config.ts (BILLABLE_METRICS).
  const ts = events[0]?.ts ?? new Date().toISOString();
  const byType = new Map<string, Record<string, number | string>>();
  for (const e of events) {
    const type = ids.eventTypes[e.metric];
    const props = byType.get(type) ?? { model: "nebula-1" };
    const key = ids.eventProperties[e.metric];
    props[key] = (Number(props[key]) || 0) + e.quantity;
    byType.set(type, props);
  }
  return [...byType].map(([event_type, properties]) => ({ transaction_id: randomUUID(), customer_id: customerKey, event_type, timestamp: ts, properties }));
}

// ---------------------------------------------------------------------------
// Mapeo de respuestas de Metronome al tipo Account
// ---------------------------------------------------------------------------

type Balance = Metronome.V1.ContractListBalancesResponse;
type MInvoice = Metronome.V1.Customers.Invoice;

export function mapBalance(ids: MetronomeIds, b: Balance, at = new Date()): CreditGrant {
  scale = ids.amountScale;
  const items = b.access_schedule?.schedule_items ?? [];
  const current = items.filter(i => new Date(i.starting_at) <= at && at < new Date(i.ending_before));
  const amount = fromMoney((current.length ? current : items).reduce((s, i) => s + i.amount, 0));
  const isCredit = b.type === "CREDIT";
  const recurring = isCredit && "recurring_credit_id" in b && !!b.recurring_credit_id;
  const kind: CreditGrant["kind"] = !isCredit ? "commit" : recurring || b.product.id === ids.recurringCreditProduct ? "recurring" : "gift";
  return { id: b.id, kind, label: b.name || b.product.name, amount, remaining: fromMoney(b.balance), createdAt: ("created_at" in b && b.created_at) || items[0]?.starting_at || at.toISOString() };
}

export function mapInvoice(inv: MInvoice): Invoice {
  const ext = inv.external_invoice;
  const paid = ext?.external_status === "PAID";
  const status: Invoice["status"] = inv.status === "DRAFT" ? "draft" : inv.status === "VOID" ? "void" : paid ? "paid" : "pending";
  const lines: InvoiceLine[] = inv.line_items.map(l => ({
    description: l.name,
    quantity: l.quantity,
    unitPrice: l.unit_price !== undefined ? l.unit_price / scale : undefined,
    amount: fromMoney(l.total),
    kind: l.type === "commit_purchase" ? "commit" : l.product_type === "SubscriptionProductListItem" ? "fee" : l.total < 0 ? "credit" : "usage",
  }));
  const type: Invoice["type"] = inv.type === "USAGE" ? "usage" : lines.some(l => l.kind === "commit") ? "commit" : "subscription";
  const desc = inv.status === "DRAFT" ? "Uso del periodo (borrador)" : type === "usage" ? "Factura de uso" : lines[0]?.description ?? "Factura";
  return {
    id: inv.id, date: inv.issued_at ?? inv.start_timestamp ?? new Date().toISOString(), description: desc, amount: fromMoney(inv.total), status, type,
    periodStart: inv.start_timestamp, periodEnd: inv.end_timestamp, lines, externalId: ext?.invoice_id ?? ext?.external_payment_id, pdfUrl: ext?.pdf_url,
  };
}

export function dailyFrom(usage: UsageEvent[]): DailyUsage[] {
  const map = new Map<string, DailyUsage>();
  for (const u of usage) {
    const k = `${u.ts.slice(0, 10)}|${u.metric}`;
    const r = map.get(k) ?? { day: u.ts.slice(0, 10), metric: u.metric, quantity: 0, cost: 0 };
    r.quantity += u.quantity; r.cost = round(r.cost + u.cost);
    map.set(k, r);
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ---------------------------------------------------------------------------
// Proveedor
// ---------------------------------------------------------------------------

function mustLink(appUserId: string): CustomerLink {
  const l = getLink(appUserId);
  if (!l) throw new Error("Cliente no encontrado");
  return l;
}

function localAlert(link: CustomerLink, type: Alert["type"], message: string) {
  addAlert(link.metronomeCustomerId, { id: `al_${randomUUID().slice(0, 8)}`, ts: new Date().toISOString(), type, message, source: "local" });
}

/** Alertas de saldo bajo (20 %) y saldo a cero como threshold notifications de Metronome (llegan por webhook). */
async function createBalanceAlerts(ids: MetronomeIds, link: CustomerLink) {
  const plan = PLANS[link.plan];
  const thresholds = [
    { name: `Saldo bajo (20 %) · ${plan.name}`, amount: money(plan.monthlyCredits * LOW_BALANCE_RATIO) },
    // metronome-setup ya crea una alerta GLOBAL de saldo 0 (sin customer_id); solo la creamos por cliente si no existe.
    ...(ids.hasGlobalZeroAlert ? [] : [{ name: `Saldo agotado · ${plan.name}`, amount: 0 }]),
  ];
  // El umbral de low_remaining_contract_credit_and_commit_balance_reached es un IMPORTE, no un porcentaje:
  // el 20 % se calcula aquí sobre los créditos del plan.
  // TODO(verificar): si threshold 0 dispara al llegar a 0 o solo por debajo, y si conviene crear estas
  //   notificaciones una vez por plan (sin customer_id + filtros) en vez de por cliente:
  //   https://docs.metronome.com/guides/customers-billing/set-up-notifications/threshold-notifications
  for (const t of thresholds) {
    await client().v1.alerts.create({
      alert_type: "low_remaining_contract_credit_and_commit_balance_reached",
      name: t.name,
      threshold: t.amount,
      customer_id: link.metronomeCustomerId,
      credit_type_id: ids.creditTypeId,
      uniqueness_key: `low-${link.metronomeCustomerId}-${link.plan}-${t.amount}`,
      evaluate_on_create: true,
    });
  }
}

async function listAllBalances(customerId: string) {
  const out: Balance[] = [];
  for await (const b of client().v1.contracts.listBalances({ customer_id: customerId, include_balance: true, include_contract_balances: true, covering_date: new Date().toISOString(), limit: 25 })) {
    out.push(b);
    if (out.length >= 100) break;
  }
  return out;
}

async function recentInvoices(customerId: string) {
  const page = await client().v1.customers.invoices.list({ customer_id: customerId, limit: 20, sort: "date_desc" });
  return page.data;
}

function resolvePending(link: CustomerLink): CustomerLink {
  if (link.pendingPlan && Date.now() >= +new Date(link.pendingPlan.effectiveAt)) {
    const l = { ...link, plan: link.pendingPlan.plan, metronomeContractId: link.pendingPlan.contractId, pendingPlan: undefined };
    saveLink(l);
    return l;
  }
  return link;
}

async function toAccount(link0: CustomerLink): Promise<Account> {
  const link = resolvePending(link0);
  const ids = idsNow();
  const [balances, invoices, contract] = await Promise.all([
    listAllBalances(link.metronomeCustomerId),
    recentInvoices(link.metronomeCustomerId),
    client().v2.contracts.retrieve({ customer_id: link.metronomeCustomerId, contract_id: link.metronomeContractId }),
  ]);
  const plan = PLANS[link.plan];
  const credits = balances.filter(b => b.type !== "POSTPAID").map(b => mapBalance(ids, b));
  const bal = round(credits.reduce((s, c) => s + c.remaining, 0));
  const mapped = invoices.map(mapInvoice);
  const draft = mapped.find(i => i.status === "draft" && i.type === "usage");
  const usage = read(db => db.usage[link.appUserId] ?? []);
  const { start, end } = utcMonth();
  return {
    customerId: link.appUserId,
    name: link.name,
    email: link.email,
    plan: link.plan,
    pendingPlan: link.pendingPlan ? { plan: link.pendingPlan.plan, effectiveAt: link.pendingPlan.effectiveAt } : undefined,
    cardSaved: !!link.stripeCustomerId,
    autoRecharge: !!contract.data.prepaid_balance_threshold_configuration?.is_enabled,
    blocked: !plan.overage && bal <= 0,
    overageAccrued: plan.overage && draft ? Math.max(0, draft.amount) : 0,
    credits,
    usage: usage.slice(0, 500),
    daily: dailyFrom(usage),
    invoices: mapped,
    alerts: getAlerts(link.metronomeCustomerId),
    periodStart: start,
    periodEnd: end,
    mode: "metronome",
  };
}

export const metronomeBilling: BillingProvider = {
  mode: "metronome",

  async signup(input) {
    const ids = idsNow();
    const appUserId = `usr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    // 1) Cliente en Metronome enlazado al cliente de Stripe.
    const customer = await client().v1.customers.create(buildCustomerBody({ ...input, appUserId }));
    // 2) Contrato del plan sobre la tarifa: suscripción + créditos recurrentes + overrides de descuento.
    const contract = await client().v1.contracts.create(buildContractBody(ids, { customerId: customer.data.id, plan: input.plan, appUserId, startingAt: hourFloor() }));
    const link: CustomerLink = {
      appUserId, name: input.name, email: input.email, plan: input.plan,
      metronomeCustomerId: customer.data.id, metronomeContractId: contract.data.id, stripeCustomerId: input.stripeCustomerId,
      createdAt: new Date().toISOString(),
    };
    saveLink(link);
    // 3) Alertas de saldo (webhooks alerts.low_remaining_contract_credit_and_commit_balance_reached).
    await createBalanceAlerts(ids, link).catch(e => console.error("[metronome] no se pudieron crear las alertas:", e));
    localAlert(link, "info", `Cuenta creada en el plan ${PLANS[input.plan].name}. Tarjeta guardada en Stripe.`);
    return toAccount(link);
  },

  async get(appUserId) {
    const link = getLink(appUserId);
    return link ? toAccount(link) : null;
  },

  async getInvoice(appUserId, invoiceId) {
    const link = mustLink(appUserId);
    const r = await client().v1.customers.invoices.retrieve({ customer_id: link.metronomeCustomerId, invoice_id: invoiceId });
    return mapInvoice(r.data);
  },

  async changePlan(appUserId, plan) {
    // Cambio de plan = CONTRATO NUEVO con transition RENEWAL desde el actual, como recomienda Metronome
    // (termina la suscripción anterior e inicia la nueva en una sola llamada, prorratea las subidas y
    // aplica el rollover de commits/créditos): https://docs.metronome.com/guides/pricing-packaging/subscription/manage-subscription-lifecycle
    // Mismo enfoque que metronome-setup/src/helpers/contracts.ts (changePlan).
    //  - Subida: empieza AHORA (redondeado a la hora); la cuota nueva se cobra prorrateada al momento (ADVANCE).
    //  - Bajada: empieza el día 1 del mes siguiente (Metronome solo prorratea subidas).
    const ids = idsNow();
    const link = resolvePending(mustLink(appUserId));
    if (link.plan === plan) return toAccount(link);
    const isUpgrade = PLANS[plan].monthlyFee > PLANS[link.plan].monthlyFee;
    const current = (await client().v2.contracts.retrieve({ customer_id: link.metronomeCustomerId, contract_id: link.metronomeContractId })).data;
    const autoRecharge = !!current.prepaid_balance_threshold_configuration?.is_enabled;
    const startingAt = isUpgrade ? hourFloor() : utcMonth().end;
    // TODO(verificar): con rollover_fraction = 1 el saldo restante de los créditos del plan anterior también pasa
    //   al contrato nuevo (el modo simulado solo añade la diferencia prorrateada). Si no se quiere, usar 0 en los
    //   créditos recurrentes: https://docs.metronome.com/guides/pricing-packaging/apply-credits-and-commits/create-a-pre-paid-commit
    const next = await client().v1.contracts.create(buildContractBody(ids, {
      customerId: link.metronomeCustomerId, plan, appUserId, startingAt, transitionFrom: link.metronomeContractId, autoRecharge,
    }));
    if (isUpgrade) {
      const l: CustomerLink = { ...link, plan, metronomeContractId: next.data.id, pendingPlan: undefined };
      saveLink(l);
      await createBalanceAlerts(ids, l).catch(e => console.error("[metronome] alertas del nuevo plan:", e));
      localAlert(l, "info", `Plan cambiado a ${PLANS[plan].name}. La cuota se cobra prorrateada y los créditos del mes se prorratean.`);
      return toAccount(l);
    }
    const l: CustomerLink = { ...link, pendingPlan: { plan, effectiveAt: startingAt, contractId: next.data.id } };
    saveLink(l);
    localAlert(l, "info", `Cambio a ${PLANS[plan].name} programado para el ${new Date(startingAt).toLocaleDateString("es-ES", { timeZone: "UTC" })}.`);
    return toAccount(l);
  },

  async buyBundle(appUserId, bundle) {
    const ids = idsNow();
    const link = mustLink(appUserId);
    if (!BUNDLES[bundle]) throw new Error("Bundle desconocido");
    await client().v2.contracts.edit(buildBundleEdit(ids, { customerId: link.metronomeCustomerId, contractId: link.metronomeContractId, bundle }));
    // El regalo se concede cuando llega el webhook payment_gate.payment_status = paid (ver webhooks/metronome).
    if (BUNDLES[bundle].credit > BUNDLES[bundle].price) {
      tx(db => { db.pendingGifts.push({ id: randomUUID(), contractId: link.metronomeContractId, bundle, createdAt: new Date().toISOString() }); });
    }
    localAlert(link, "info", `Pago de ${eur(BUNDLES[bundle].price)} iniciado en Stripe. El saldo se libera al confirmarse el pago.`);
    return toAccount(link);
  },

  async setAutoRecharge(appUserId, enabled) {
    const ids = idsNow();
    const link = mustLink(appUserId);
    if (enabled && !PLANS[link.plan].autoRechargeAllowed) throw new Error("La recarga automática solo está disponible en Pro y Scale");
    const c = (await client().v2.contracts.retrieve({ customer_id: link.metronomeCustomerId, contract_id: link.metronomeContractId })).data;
    const base = { customer_id: link.metronomeCustomerId, contract_id: link.metronomeContractId, uniqueness_key: `autorecharge-${link.metronomeContractId}-${enabled}-${Date.now()}` };
    if (c.prepaid_balance_threshold_configuration) {
      await client().v2.contracts.edit({ ...base, update_prepaid_balance_threshold_configuration: { is_enabled: enabled } });
    } else if (enabled) {
      await client().v2.contracts.edit({ ...base, add_prepaid_balance_threshold_configuration: thresholdConfig(ids) });
    }
    return toAccount(link);
  },

  async ingest(appUserId, events) {
    const ids = idsNow();
    const link = mustLink(appUserId);
    const plan = PLANS[link.plan];
    // Free/Pro: sin saldo no se acepta uso. Metronome no bloquea por sí mismo, lo decide la app.
    // TODO(verificar): los saldos de Metronome se actualizan con cierto retraso tras la ingesta, así que puede
    //   colarse algo de uso por encima de 0. Para cortar en tiempo real haría falta un contador local o
    //   escuchar el webhook de saldo a 0.
    if (!plan.overage) {
      const balances = await listAllBalances(link.metronomeCustomerId);
      const bal = balances.filter(b => b.type !== "POSTPAID").reduce((s, b) => s + (b.balance ?? 0), 0);
      if (bal <= 0) return { account: await toAccount(link), rejected: true };
    }
    const valid = events.filter(e => e.metric in METRICS && e.quantity > 0);
    if (valid.length) {
      await client().v1.usage.ingest({ usage: buildIngestEvents(ids, appUserId /* alias de ingesta */, valid) });
      const ts = valid[0].ts ?? new Date().toISOString();
      tx(db => {
        const list = (db.usage[appUserId] ??= []);
        // Coste estimado localmente con el catálogo (solo para la gráfica; la cifra buena es la de Metronome).
        for (const e of valid) list.unshift({ id: `ev_${randomUUID().slice(0, 8)}`, ts, metric: e.metric, quantity: e.quantity, cost: usageCost(e.metric, e.quantity, plan.discount) });
        db.usage[appUserId] = list.slice(0, 2000);
      });
    }
    return { account: await toAccount(link), rejected: false };
  },
};

/** Concede el saldo de regalo pendiente cuando Stripe confirma el pago de un commit (webhook). */
export async function releasePendingGift(contractId: string) {
  const ids = idsNow();
  const pending = tx(db => {
    const i = db.pendingGifts.findIndex(g => g.contractId === contractId);
    return i >= 0 ? db.pendingGifts.splice(i, 1)[0] : null;
  });
  if (!pending) return false;
  const link = read(db => Object.values(db.links).find(l => l.metronomeContractId === contractId || l.pendingPlan?.contractId === contractId));
  if (!link) return false;
  const body = buildGiftEdit(ids, { customerId: link.metronomeCustomerId, contractId, bundle: pending.bundle });
  if (body) await client().v2.contracts.edit(body);
  return true;
}
