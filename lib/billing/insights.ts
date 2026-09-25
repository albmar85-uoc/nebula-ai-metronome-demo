// Cálculos puros compartidos por los modos simulado y en vivo, con las formas de metronome-types.ts.
import { ENTERPRISE_EXAMPLE, METRICS, PLANS, type MetricId, type PlanId } from "../catalog";
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

/** Recomendador puro (misma fórmula que recommendPlan del setup): cuota + max(0, uso con descuento − créditos). */
export function recommendPlan(usage: UsageLast30Days, currentPlan?: PlanId): PlanRecommendation {
  const estimates: PlanCostEstimate[] = (Object.keys(PLANS) as PlanId[]).map(k => {
    const p = PLANS[k];
    const usageCost = round2(usage.totalListCostEur * (1 - p.discount));
    const extra = round2(Math.max(0, usageCost - p.monthlyCredits));
    return { plan: k, monthlyFeeEur: p.monthlyFee, usageCostAfterDiscountEur: usageCost, includedCreditsEur: p.monthlyCredits, extraEur: extra, totalMonthlyEur: round2(p.monthlyFee + extra) };
  });
  const best = [...estimates].sort((a, b) => a.totalMonthlyEur - b.totalMonthlyEur || PLANS[a.plan].rank - PLANS[b.plan].rank)[0];
  const cur = currentPlan ? estimates.find(e => e.plan === currentPlan) : undefined;
  return { basedOn: usage, estimates, recommended: best.plan, savingsVsCurrentEur: cur ? round2(cur.totalMonthlyEur - best.totalMonthlyEur) : undefined };
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
