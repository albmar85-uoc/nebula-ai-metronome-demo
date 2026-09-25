// Adaptador real de Metronome (modo en vivo). Se activa con METRONOME_API_KEY (o METRONOME_API_TOKEN) + METRONOME_LIVE=1.
// Toda la lógica de API está en metronome-helpers.ts (port de los helpers del experto, /workspace/metronome-setup/src/helpers);
// aquí solo se orquesta: enlace usuario ↔ IDs externos (store), idempotencia con ids de la app y mapeo a la UI.
import Metronome from "@metronome/sdk";
import { createHash } from "node:crypto";
import { METRICS, PLANS, eur, type MetricId, type PlanId } from "../catalog";
import { addAlert, addPlanEvent, addPurchase, claimRequestIds, getAlerts, getLink, getPurchase, pendingPurchases, read, resolvePurchase, saveLink, tx, findLinkByMetronomeId, type CustomerLink } from "../store";
import { recommendPlan, usageLast30DaysFromDaily } from "./insights";
import { capAlerts, capMessage, fitsCap, normalizeCap, periodSpend, requestCost } from "./limits";
import { loadMetronomeIds, planDisplayName, promotionFromIds } from "./metronome-config";
import * as H from "./metronome-helpers";
import type { CreditGrantView, InvoiceView } from "./metronome-types";
import { round, usageCost } from "./mock";
import type { Account, Alert, BillingProvider, RejectReason, CreditGrant, DailyUsage, Invoice, UsageEvent, UsageRequest } from "./types";

let _client: Metronome | null = null;
export const client = () =>
  (_client ??= new Metronome({ bearerToken: process.env.METRONOME_API_KEY || process.env.METRONOME_API_TOKEN || process.env.METRONOME_BEARER_TOKEN, webhookSecret: process.env.METRONOME_WEBHOOK_SECRET ?? null }));
export const ctx = (): H.Ctx => ({ client: client(), ids: loadMetronomeIds() });

/** Id de usuario determinista por cliente de Stripe: repetir el retorno de Checkout no crea otro cliente (ingest alias idempotente). */
export const appUserIdFor = (stripeCustomerId: string) => `usr_${createHash("sha256").update(stripeCustomerId).digest("hex").slice(0, 16)}`;

// ─────────────────────────── mapeos a la UI ───────────────────────────

const KIND: Record<CreditGrantView["kind"], CreditGrant["kind"]> = {
  plan_credit: "recurring", promo: "promo", bundle_bonus: "gift", bundle_commit: "commit", auto_recharge: "commit", spend_threshold: "commit", enterprise_commit: "commit", other: "commit",
};
export function mapGrant(g: CreditGrantView): CreditGrant {
  return { id: g.id, kind: KIND[g.kind], label: g.name || g.kind, amount: g.grantedEur, remaining: g.remainingEur, createdAt: g.startsAt ?? "", expiresAt: g.expiresAt, reference: g.reference };
}

export function mapInvoice(i: InvoiceView): Invoice {
  const status: Invoice["status"] = i.status === "DRAFT" ? "draft" : i.status === "VOID" ? "void" : i.stripeStatus && !/paid/i.test(i.stripeStatus) ? "pending" : "paid";
  const kindOf = (t: string) => (t === "usage" ? "usage" : t === "subscription" ? "fee" : t === "applied_commit_or_credit" ? "credit" : t === "commit_purchase" ? "commit" : undefined);
  return {
    id: i.id, date: i.issuedAt ?? i.periodEnd ?? i.periodStart ?? "", amount: i.totalEur, status,
    description: i.type === "USAGE" ? (status === "draft" ? "Usage this period (draft)" : "Usage invoice") : i.type === "SCHEDULED" ? "Scheduled charge (commit/bundle)" : i.type,
    type: i.type === "USAGE" ? "usage" : "commit", periodStart: i.periodStart, periodEnd: i.periodEnd,
    lines: i.lines.map(l => ({ description: l.name, quantity: l.quantity, unitPrice: l.unitPriceEur, amount: l.totalEur, kind: kindOf(l.type) })),
    externalId: i.stripeInvoiceId, pdfUrl: i.pdfUrl,
  };
}

export function dailyFrom(usage: UsageEvent[]): DailyUsage[] {
  const map = new Map<string, DailyUsage>();
  for (const e of usage) {
    const k = `${e.ts.slice(0, 10)}|${e.metric}`;
    const row = map.get(k) ?? { day: e.ts.slice(0, 10), metric: e.metric, quantity: 0, cost: 0 };
    row.quantity += e.quantity;
    row.cost = round(row.cost + e.cost);
    map.set(k, row);
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Eventos de /v1/ingest para una petición: transaction_id = id de la petición de la app (sin fusionar peticiones). */
export function buildIngestEvents(c: H.Ctx, customer: string, r: UsageRequest): H.IngestEvent[] {
  const out: H.IngestEvent[] = [];
  const hasText = (r.inputTokens ?? 0) > 0 || (r.outputTokens ?? 0) > 0;
  const model = r.model ?? "nebula-1";
  if (hasText) out.push(H.llmRequestEvent(c, { transactionId: r.requestId, customer, inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, model, timestamp: r.ts }));
  if ((r.images ?? 0) > 0) {
    // Si una misma petición trae texto e imágenes son dos event_type distintos: sufijo determinista para el segundo.
    out.push(H.imageGenerationEvent(c, { transactionId: hasText ? `${r.requestId}:images` : r.requestId, customer, images: r.images!, model, timestamp: r.ts }));
  }
  return out;
}

// ─────────────────────────── utilidades ───────────────────────────

function mustLink(appUserId: string): CustomerLink {
  const l = getLink(appUserId);
  if (!l) throw new Error("Customer not found");
  return l;
}

function localAlert(key: string, type: Alert["type"], message: string, idSuffix: string) {
  addAlert(key, { id: `loc_${idSuffix}`, ts: new Date().toISOString(), type, message, source: "local" });
}

/** Aplica una bajada programada cuando llega su fecha y re-sincroniza la alerta del 20 % del nuevo plan. */
async function resolvePending(link: CustomerLink): Promise<CustomerLink> {
  if (!link.pendingPlan || new Date(link.pendingPlan.effectiveAt) > new Date()) return link;
  const next: CustomerLink = { ...link, plan: link.pendingPlan.plan, metronomeContractId: link.pendingPlan.contractId, pendingPlan: undefined };
  saveLink(next);
  addPlanEvent(link.appUserId, { ts: link.pendingPlan.effectiveAt, kind: "downgrade_applied", from: link.plan, to: next.plan, actor: "system", effectiveAt: link.pendingPlan.effectiveAt, contractId: next.metronomeContractId });
  await H.syncPlanLowBalanceAlert(ctx(), next.metronomeCustomerId, next.plan).catch(e => console.error("[metronome] syncPlanLowBalanceAlert:", e));
  return next;
}

async function toAccount(link0: CustomerLink): Promise<Account> {
  const link = await resolvePending(link0);
  const c = ctx();
  const cid = link.metronomeCustomerId;
  const [balances, invoices, contract, upcoming, usage30] = await Promise.all([
    H.getBalanceSummary(c, cid),
    H.listInvoices(c, cid),
    H.getContract(c, cid, link.metronomeContractId),
    H.getUpcomingInvoicePreview(c, cid, link.metronomeContractId).catch(() => undefined),
    H.getUsageLast30Days(c, cid).catch(() => undefined),
  ]);
  const summary = H.summarizeContract(contract, c.ids.amount_scale || 1);
  const plan = PLANS[link.plan];
  const credits = balances.grants.filter(g => g.metronomeType !== "POSTPAID").map(mapGrant);
  const bal = round(credits.reduce((s, x) => s + x.remaining, 0));
  // El corte por webhook se levanta cuando vuelve a haber saldo (con 2 min de margen por el retraso de listBalances).
  let accessCut = !!link.accessCut;
  if (accessCut && bal > 0 && Date.now() - +new Date(link.accessCutAt ?? 0) > 120_000) { accessCut = false; saveLink({ ...link, accessCut: false }); }
  const usage = read(db => db.usage[link.appUserId] ?? []);
  const daily = dailyFrom(usage);
  const u30 = usage30 ?? usageLast30DaysFromDaily(cid, daily);
  const usageDue = upcoming ? upcoming.lines.filter(l => l.type !== "subscription").reduce((s, l) => s + l.totalEur, 0) : 0;
  const now = new Date();
  return {
    customerId: link.appUserId, name: link.name, email: link.email, plan: link.plan,
    pendingPlan: link.pendingPlan ? { plan: link.pendingPlan.plan, effectiveAt: link.pendingPlan.effectiveAt } : undefined,
    cardSaved: !!link.stripeCustomerId,
    autoRecharge: !!summary.autoRecharge?.enabled,
    spendThreshold: summary.spendThreshold,
    blocked: !plan.overage && (bal <= 0 || accessCut),
    spendCap: link.spendCap,
    accessCut,
    overageAccrued: plan.overage ? Math.max(0, round(usageDue)) : 0,
    credits, usage: usage.slice(0, 500), daily,
    invoices: invoices.map(mapInvoice),
    alerts: getAlerts(cid),
    periodStart: upcoming?.periodStart ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    periodEnd: upcoming?.periodEnd ?? H.nextPeriodStart(summary.billingAnchorDate ?? contract.starting_at),
    mode: "metronome",
    upcoming, usage30: u30, recommendation: recommendPlan(u30, link.plan),
  };
}

// ─────────────────────────── acciones disparadas por webhooks ───────────────────────────

/** Webhook de saldo 0 (alerta global del setup) → corta el acceso en Free/Pro; Scale sigue (overage). */
export function setAccessCutLive(metronomeCustomerId: string, cut: boolean) {
  const link = findLinkByMetronomeId(metronomeCustomerId);
  if (!link) return false;
  const effective = cut && !PLANS[link.plan].overage;
  saveLink({ ...link, accessCut: effective, accessCutAt: effective ? new Date().toISOString() : link.accessCutAt });
  return true;
}

/**
 * payment_gate.payment_status (workflow manual_commit). El webhook trae customer_id + contract_id + invoice_id, NO el id
 * de compra: se recorren las compras pendientes del cliente y, para cada purchaseId, se comprueba con findBundleCommit
 * (custom field nebula_purchase_id) si el commit existe. Solo entonces se concede el bonus (uniqueness_key por compra).
 * Si el pago falló, las compras cuyo commit no existe se marcan como fallidas (Metronome no crea el commit ni reintenta).
 */
export async function confirmBundlePaymentsLive(metronomeCustomerId: string, paid: boolean) {
  const c = ctx();
  const done: string[] = [];
  for (const p of pendingPurchases(metronomeCustomerId)) {
    const commit = await H.findBundleCommit(c, metronomeCustomerId, p.purchaseId);
    if (paid && commit) {
      await H.grantBundleBonus(c, { customerId: metronomeCustomerId, contractId: commit.contract?.id ?? p.contractId, bundle: p.bundle, purchaseId: p.purchaseId });
      resolvePurchase(p.purchaseId, "bonus_granted");
      done.push(p.purchaseId);
    } else if (!commit && (!paid || Date.now() - +new Date(p.createdAt) > 24 * 3600_000)) {
      resolvePurchase(p.purchaseId, "failed");
      done.push(p.purchaseId);
    }
  }
  return done;
}

// ─────────────────────────── proveedor ───────────────────────────

export const metronomeBilling: BillingProvider = {
  mode: "metronome",
  async signup(input) {
    if (!input.stripeCustomerId) throw new Error("Missing Stripe customer: complete Stripe Checkout (setup mode) first.");
    const appUserId = appUserIdFor(input.stripeCustomerId);
    const existing = getLink(appUserId);
    if (existing) return toAccount(existing); // retorno de Checkout repetido
    const c = ctx();
    const customer = await H.createCustomerWithStripe(c, { name: input.name, ingestAlias: appUserId, stripeCustomerId: input.stripeCustomerId });
    const contractId = await H.createPlanContract(c, {
      customerId: customer.metronomeCustomerId, plan: input.plan, spendThreshold: input.plan === "scale",
      uniquenessKey: `nebula-signup-${customer.metronomeCustomerId}`, // una sola alta por cliente, aunque se reintente
    });
    const link: CustomerLink = {
      appUserId, name: input.name, email: input.email, plan: input.plan,
      metronomeCustomerId: customer.metronomeCustomerId, metronomeContractId: contractId, stripeCustomerId: input.stripeCustomerId,
      createdAt: new Date().toISOString(),
    };
    saveLink(link);
    addPlanEvent(appUserId, { ts: link.createdAt, kind: "signup", to: input.plan, actor: "customer", contractId });
    await H.syncPlanLowBalanceAlert(c, link.metronomeCustomerId, link.plan).catch(e => console.error("[metronome] alerta 20 %:", e));
    localAlert(link.metronomeCustomerId, "info", `Account created on the ${planDisplayName(c.ids, input.plan)} plan. Card saved in Stripe.`, `signup_${appUserId}`);
    return toAccount(link);
  },
  async get(appUserId) {
    const link = getLink(appUserId);
    return link ? toAccount(link) : null;
  },
  async getInvoice(appUserId, invoiceId) {
    const link = mustLink(appUserId);
    try { return mapInvoice(await H.getInvoice(ctx(), link.metronomeCustomerId, invoiceId)); } catch { return null; }
  },
  async changePlan(appUserId, plan, actor = "customer") {
    const link = await resolvePending(mustLink(appUserId));
    if (!PLANS[plan]) throw new Error("Unknown plan");
    if (link.plan === plan && link.pendingPlan) {
      // TODO(verificar): cancelar una bajada programada = archivar el contrato futuro (POST /v1/contracts/archive) y
      // quitar el ending_before del actual. No está en los helpers del setup; pendiente de confirmar con Metronome.
      throw new Error("To cancel a scheduled downgrade, please contact support.");
    }
    const c = ctx();
    const r = await H.changePlan(c, link.metronomeCustomerId, plan);
    if (r.kind === "upgrade" && r.newContractId) {
      saveLink({ ...link, plan, metronomeContractId: r.newContractId, pendingPlan: undefined, accessCut: false });
      addPlanEvent(appUserId, { ts: new Date().toISOString(), kind: "upgrade", from: link.plan, to: plan, actor, contractId: r.newContractId });
      // Archiva la alerta del 20 % del plan anterior y crea la del nuevo (evaluate_on_create).
      await H.syncPlanLowBalanceAlert(c, link.metronomeCustomerId, plan).catch(e => console.error("[metronome] alerta 20 %:", e));
      localAlert(link.metronomeCustomerId, "info", `Plan changed to ${planDisplayName(c.ids, plan)}. Your previous balance carries over.`, `plan_${r.newContractId}`);
    } else if (r.kind === "downgrade" && r.newContractId) {
      saveLink({ ...link, pendingPlan: { plan, effectiveAt: r.effectiveAt, contractId: r.newContractId } });
      addPlanEvent(appUserId, { ts: new Date().toISOString(), kind: "downgrade_scheduled", from: link.plan, to: plan, actor, effectiveAt: r.effectiveAt, contractId: r.newContractId });
      localAlert(link.metronomeCustomerId, "info", `Downgrade to ${PLANS[plan].name} scheduled for ${new Date(r.effectiveAt).toLocaleDateString("en-US", { timeZone: "UTC" })}. You'll keep your bundles, gifts and promos.`, `plan_${r.newContractId}`);
    }
    return toAccount(getLink(appUserId)!);
  },
  async buyBundle(appUserId, bundle, purchaseId) {
    const link = mustLink(appUserId);
    if (!getPurchase(purchaseId)) {
      addPurchase({ purchaseId, customerKey: link.metronomeCustomerId, contractId: link.metronomeContractId, bundle, status: "payment_pending", createdAt: new Date().toISOString() });
    }
    // Commit con payment gate: Metronome cobra en Stripe al momento; el bonus llega con el webhook de pago.
    await H.buyBundle(ctx(), { customerId: link.metronomeCustomerId, contractId: link.metronomeContractId, bundle, purchaseId });
    return toAccount(link);
  },
  async setAutoRecharge(appUserId, enabled) {
    const link = mustLink(appUserId);
    await H.setAutoRecharge(ctx(), link.metronomeCustomerId, link.metronomeContractId, enabled);
    return toAccount(link);
  },
  async setSpendThreshold(appUserId, enabled) {
    const link = mustLink(appUserId);
    await H.setSpendThreshold(ctx(), link.metronomeCustomerId, link.metronomeContractId, enabled);
    return toAccount(link);
  },
  async redeemPromo(appUserId, rawCode) {
    const link = mustLink(appUserId);
    const code = rawCode.trim().toUpperCase();
    // Códigos y nombres de metronome-ids.json (catalog.promotions del setup); el catálogo de la web solo rellena huecos.
    const promo = promotionFromIds(ctx().ids, code);
    if (!promo) throw new Error("Invalid promo code");
    const r = await H.grantPromoCredit(ctx(), { customerId: link.metronomeCustomerId, contractId: link.metronomeContractId, code, label: promo.label, amountEur: promo.amount, validDays: promo.validDays });
    localAlert(link.metronomeCustomerId, "info", `Code ${code} redeemed: ${eur(r.amountEur)} in credit until ${new Date(r.expiresAt).toLocaleDateString("en-US", { timeZone: "UTC" })}.`, `promo_${code}`);
    return toAccount(link);
  },
  async ingest(appUserId, requests) {
    const link = mustLink(appUserId);
    const plan = PLANS[link.plan];
    // Corte duro Free/Pro (lo hace la app; Metronome no bloquea): webhook de saldo 0 + consulta del saldo neto.
    const blocked = { rejected: true, reason: "blocked" as RejectReason, duplicates: 0, accepted: [] as string[] };
    if (!plan.overage) {
      if (link.accessCut) return { account: await toAccount(link), ...blocked };
      const net = await H.getNetBalanceEur(ctx(), link.metronomeCustomerId);
      if (net <= 0) return { account: await toAccount(link), ...blocked };
    }
    const valid = requests.filter(r => r.requestId);
    // Límite de gasto del cliente (regla de la app): con la copia local del uso del periodo, a precio de plan.
    // TODO(verificar): el periodo local es el mes natural UTC; en vivo debería usarse el periodo del contrato (upcoming.periodStart).
    let capHit = false;
    const inCap: UsageRequest[] = [];
    if (link.spendCap) {
      const now = new Date();
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      let spent = periodSpend(dailyFrom(read(db => db.usage[appUserId] ?? [])), periodStart);
      for (const r of valid) {
        const cost = requestCost(r, plan.discount);
        if (!fitsCap(link.spendCap, spent, cost)) { capHit = true; break; }
        spent += cost; inCap.push(r);
      }
    } else inCap.push(...valid);
    const fresh = new Set(claimRequestIds(appUserId, inCap.map(r => r.requestId)));
    const todo = inCap.filter(r => fresh.has(r.requestId));
    const c = ctx();
    await H.ingest(c, todo.flatMap(r => buildIngestEvents(c, appUserId, r)));
    // Copia local (coste estimado a precio de plan) solo para gráficas y listados.
    const local: UsageEvent[] = todo.flatMap(r => {
      const ts = r.ts ?? new Date().toISOString();
      const parts: [MetricId, number][] = [["input_tokens", r.inputTokens ?? 0], ["output_tokens", r.outputTokens ?? 0], ["images", r.images ?? 0]];
      return parts.filter(([, q]) => q > 0).map(([metric, quantity]) => ({ id: `${r.requestId}:${metric}`, requestId: r.requestId, ts, metric, quantity, cost: usageCost(metric, quantity, plan.discount), source: r.source }));
    });
    tx(db => { db.usage[appUserId] = [...local, ...(db.usage[appUserId] ?? [])].slice(0, 5000); });
    if (link.spendCap) {
      const now = new Date();
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const spent = periodSpend(dailyFrom(read(db => db.usage[appUserId] ?? [])), periodStart);
      const cap = { ...link.spendCap };
      const kinds = capAlerts(cap, capHit ? cap.monthlyEur : spent, periodStart);
      if (kinds.length) {
        saveLink({ ...getLink(appUserId)!, spendCap: cap });
        for (const k of kinds) localAlert(link.metronomeCustomerId, "spend_cap", capMessage(k, cap, spent, eur), `cap${k}_${appUserId}_${periodStart.slice(0, 7)}`);
      }
    }
    return { account: await toAccount(getLink(appUserId)!), rejected: capHit, reason: capHit ? "spend_cap" : undefined, duplicates: inCap.length - todo.length, accepted: todo.map(r => r.requestId) };
  },
  async setSpendCap(appUserId, monthlyEur) {
    // Regla de la app (Metronome no rechaza peticiones). El aviso del 80 % lo emite la app al ingerir.
    // TODO(verificar): alternativa en Metronome = alerta de cliente de tipo gasto/uso (p. ej. "usage_threshold_reached"
    // sobre el total facturable) que llegue por webhook; no está en los helpers del setup.
    const link = mustLink(appUserId);
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const spent = periodSpend(dailyFrom(read(db => db.usage[appUserId] ?? [])), periodStart);
    const cap = normalizeCap(monthlyEur, spent, link.spendCap);
    saveLink({ ...link, spendCap: cap });
    localAlert(link.metronomeCustomerId, "info", cap ? `Monthly spend limit set to ${eur(cap.monthlyEur)}.` : "Monthly spend limit removed.", `cap_${appUserId}_${Date.now()}`);
    return toAccount(getLink(appUserId)!);
  },
  async grantGoodwill(appUserId, g) {
    // Crédito de cortesía = crédito promocional con código único por concesión (uniqueness_key nebula-promo-<cliente>-GOODWILL-<id>).
    // TODO(verificar): quizá convenga un producto propio "goodwill_credit" en el setup para separarlo en los informes.
    const link = mustLink(appUserId);
    const code = `GOODWILL-${g.grantId}`.slice(0, 60);
    try {
      await H.grantPromoCredit(ctx(), { customerId: link.metronomeCustomerId, contractId: link.metronomeContractId, code, label: `Goodwill credit (support): ${g.reason}`.slice(0, 120), amountEur: g.amountEur, validDays: g.validDays });
    } catch (e) {
      if (!/already redeemed/.test((e as Error).message)) throw e; // mismo grantId: idempotente
    }
    saveLink({ ...link, accessCut: false });
    localAlert(link.metronomeCustomerId, "support", `Our support team added ${eur(g.amountEur)} of goodwill credit. Reason: ${g.reason}`, `gw_${g.grantId}`);
    return toAccount(getLink(appUserId)!);
  },
  async unblock(appUserId) {
    const link = mustLink(appUserId);
    saveLink({ ...link, accessCut: false });
    localAlert(link.metronomeCustomerId, "support", "Support has re-enabled your API access.", `unblock_${appUserId}_${Date.now()}`);
    return toAccount(getLink(appUserId)!);
  },
};

export { METRICS };
