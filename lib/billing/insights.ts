// Cálculos puros compartidos por los modos simulado y en vivo, con las formas de metronome-types.ts.
import { BUNDLES, ENTERPRISE_EXAMPLE, METRICS, PLANS, type BundleId, type MetricId, type PlanId } from "../catalog";
import type { EnterpriseContractSummary, EnterpriseContractTerms, MetricUsage, PlanCostEstimate, PlanRecommendation, UsageLast30Days } from "./metronome-types";
import type { DailyUsage } from "./types";

export const round2 = (n: number) => Math.round(n * 100) / 100;
const midnightUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Ventana igual que buildUsageLast30DaysBody del setup: 30 días que terminan mañana a medianoche UTC (incluye hoy). */
export function usageWindow(now = new Date()) {
  const end = midnightUtc(now);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Construye UsageLast30Days a partir de agregados diarios locales (modo simulado / copia local en vivo). */
export function usageLast30DaysFromDaily(customerId: string, daily: DailyUsage[], now = new Date(), billableMetricIds?: Partial<Record<MetricId, string>>): UsageLast30Days {
  const { start, end } = usageWindow(now);
  const days: string[] = [];
  for (let d = new Date(start); d < new Date(end); d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString());
  const metrics = {} as Record<MetricId, MetricUsage>;
  for (const m of Object.keys(METRICS) as MetricId[]) {
    const series = days.map(day => ({ day, value: daily.filter(r => r.metric === m && r.day === day.slice(0, 10)).reduce((s, r) => s + r.quantity, 0) }));
    const total = series.reduce((s, x) => s + x.value, 0);
    metrics[m] = { metric: m, billableMetricId: billableMetricIds?.[m] ?? `sim-${m}`, total, daily: series, listCostEur: round2(total * METRICS[m].pricePerUnit) };
  }
  return { customerId, windowStart: start, windowEnd: end, metrics, totalListCostEur: round2(Object.values(metrics).reduce((s, x) => s + x.listCostEur, 0)) };
}

export type PlanEstimate = PlanCostEstimate & {
  /** Lo que de verdad pagarías por el extra: overage 1:1 en Scale; en Free/Pro, bundles con regalo (precio/crédito). */
  extraPaidEur: number;
  coverage: "incluido" | "bundles" | "overage";
  bundle?: BundleId;
  note: string;
  /** Positivo = más barato que tu plan actual. */
  savingsVsCurrentEur?: number;
};
export type PlanComparison = Omit<PlanRecommendation, "estimates"> & {
  estimates: PlanEstimate[];
  currentPlan?: PlanId;
  /** Días con datos dentro de la ventana (desde el primer día con uso). */
  observedDays: number;
  /** true si el uso se ha extrapolado a 30 días (menos de 30 días de datos). */
  projected: boolean;
  monthlyListCostEur: number;
  /** Gasto alto: conviene hablar con ventas (Enterprise con commit anual y precios negociados). */
  enterpriseHint: boolean;
};

export const ENTERPRISE_HINT_EUR = 1500;
const MIN_OBSERVED_DAYS = 7;

/** Bundle más rentable que se gastaría dentro de su validez (12 meses) al ritmo de extra mensual dado. */
export function bestBundleFor(extraPerMonth: number): BundleId {
  const fits = (Object.values(BUNDLES) as (typeof BUNDLES)[BundleId][]).filter(b => b.credit <= extraPerMonth * b.validityMonths);
  const pool = fits.length ? fits : [BUNDLES.b50];
  return pool.sort((a, b) => a.price / a.credit - b.price / b.credit)[0].id;
}

/**
 * Comparador de planes con el uso real de los últimos 30 días (proyectado a un mes si hay menos datos).
 * Por plan: cuota + coste del extra por encima de los créditos incluidos, con el descuento del plan y la forma real
 * de pagar ese extra (Scale: overage a fin de mes; Free/Pro: bundles prepagados con su regalo).
 * Compatible con PlanRecommendation del setup (mismos campos, más detalle).
 */
export function recommendPlan(usage: UsageLast30Days, currentPlan?: PlanId): PlanComparison {
  const days = Object.values(usage.metrics)[0]?.daily.length ?? 30;
  let first = days;
  for (const m of Object.values(usage.metrics)) {
    const i = m.daily.findIndex(d => d.value > 0);
    if (i >= 0) first = Math.min(first, i);
  }
  const observedDays = first >= days ? 0 : days - first;
  const projected = observedDays > 0 && observedDays < days;
  const factor = projected ? days / Math.max(MIN_OBSERVED_DAYS, observedDays) : 1;
  const list = round2(usage.totalListCostEur * factor);
  const estimates: PlanEstimate[] = (Object.keys(PLANS) as PlanId[]).map(k => {
    const p = PLANS[k];
    const usageCost = round2(list * (1 - p.discount));
    const extra = round2(Math.max(0, usageCost - p.monthlyCredits));
    let extraPaid = extra, coverage: PlanEstimate["coverage"] = "incluido", bundle: BundleId | undefined, note = "Your usage fits within the included credits.";
    if (extra > 0 && p.overage) { coverage = "overage"; note = "Overage is billed at month end at the discounted price."; }
    else if (extra > 0) {
      bundle = bestBundleFor(extra);
      const b = BUNDLES[bundle];
      extraPaid = round2(extra * (b.price / b.credit));
      coverage = "bundles";
      note = `Overage is covered with €${b.price} bundles (€${b.credit} of balance); without balance, access pauses.`;
    }
    return { plan: k, monthlyFeeEur: p.monthlyFee, usageCostAfterDiscountEur: usageCost, includedCreditsEur: p.monthlyCredits, extraEur: extra, extraPaidEur: extraPaid, coverage, bundle, note, totalMonthlyEur: round2(p.monthlyFee + extraPaid) };
  });
  const cur = currentPlan ? estimates.find(e => e.plan === currentPlan) : undefined;
  if (cur) for (const e of estimates) e.savingsVsCurrentEur = round2(cur.totalMonthlyEur - e.totalMonthlyEur);
  const best = observedDays === 0
    ? estimates.find(e => e.plan === (currentPlan ?? "free"))!
    : [...estimates].sort((a, b) => a.totalMonthlyEur - b.totalMonthlyEur || PLANS[a.plan].rank - PLANS[b.plan].rank)[0];
  return {
    basedOn: usage, estimates, recommended: best.plan, currentPlan,
    savingsVsCurrentEur: cur ? round2(cur.totalMonthlyEur - best.totalMonthlyEur) : undefined,
    observedDays, projected, monthlyListCostEur: list, enterpriseHint: best.totalMonthlyEur >= ENTERPRISE_HINT_EUR,
  };
}

/** Propuesta Enterprise simulada (lo que devolvería createEnterpriseContract), a partir de EnterpriseContractTerms. */
export function enterpriseProposal(terms: Partial<EnterpriseContractTerms> & { customerId: string }, now = new Date()): EnterpriseContractSummary & { monthlyEquivalentEur: number; savingsVsListPct: number } {
  const start = new Date(now); start.setUTCMinutes(0, 0, 0);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + (terms.termMonths ?? ENTERPRISE_EXAMPLE.termMonths));
  const rateOverrides = terms.rateOverrides ?? ENTERPRISE_EXAMPLE.rateOverrides;
  const commit = terms.commitAmountEur ?? ENTERPRISE_EXAMPLE.commitAmountEur;
  const listPerUnit = (m: MetricId) => METRICS[m].pricePerUnit * (m === "images" ? 1 : 1_000_000);
  const savings = rateOverrides.reduce((s, o) => s + (1 - o.priceEur / listPerUnit(o.metric)), 0) / Math.max(1, rateOverrides.length);
  return {
    contractId: `sim-ent-${terms.customerId}`,
    customerId: terms.customerId,
    startingAt: start.toISOString(),
    endingBefore: end.toISOString(),
    commitType: terms.commitType ?? ENTERPRISE_EXAMPLE.commitType,
    commitAmountEur: commit,
    rateOverrides,
    usageMultiplier: terms.usageMultiplier,
    monthlyEquivalentEur: round2(commit / (terms.termMonths ?? ENTERPRISE_EXAMPLE.termMonths)),
    savingsVsListPct: Math.round(savings * 100),
  };
}
