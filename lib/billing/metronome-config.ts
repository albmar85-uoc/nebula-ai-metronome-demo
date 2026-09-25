// IDs de Metronome para el modo en vivo, en el formato EXACTO de metronome-ids.json del setup del experto
// (/workspace/metronome-setup/src/ids.ts → type MetronomeIds). Los helpers (metronome-helpers.ts) usan
// ctx.ids.products.fixed.bundle_commit, ctx.ids.credit_types.EUR, etc., igual que los del setup.
//   Ruta: $METRONOME_IDS_FILE || ../metronome-setup/metronome-ids.json (relativa al cwd de la web).
//   Si no hay fichero, se construye el mismo objeto a partir de variables de entorno (ver .env.example).
import fs from "node:fs";
import path from "node:path";
import { AUTO_RECHARGE, BUNDLES, PLANS, PROMOTIONS, SPEND_THRESHOLD, eur, type BundleId, type MetricId, type PlanId } from "../catalog";

export type FixedProductKey = "plan_credits" | "bundle_commit" | "bundle_bonus" | "auto_recharge" | "spend_threshold" | "promo_credit" | "enterprise_commit";
export type SubscriptionPlanKey = Exclude<PlanId, "free">;

/** = MetronomeIds de metronome-setup/src/ids.ts */
export type MetronomeIds = {
  generated_at: string;
  base_url: string;
  dry_run: boolean;
  credit_types: { EUR: string };
  billable_metrics: Record<MetricId, string>;
  products: { usage: Record<MetricId, string>; subscription: Record<SubscriptionPlanKey, string>; fixed: Record<FixedProductKey, string> };
  rate_card: { id: string; alias: string };
  alerts: { zero_balance?: string; zero_balance_uniqueness_key: string };
  event_types: Record<MetricId, string>;
  event_properties: Record<MetricId, string>;
  auto_recharge: { threshold_eur: number; recharge_to_eur: number };
  spend_threshold: { scale_threshold_eur: number };
  amount_scale: number;
  catalog: {
    plans: Record<PlanId, { display_name: string; monthly_fee_eur: number; monthly_credits_eur: number; usage_multiplier: number; subscription_product_id?: string }>;
    bundles: Record<string, { display_name: string; paid_eur: number; bonus_eur: number }>;
    /** Códigos promocionales (clave = código en mayúsculas, p. ej. WELCOME10); display_name visible en factura/UI. */
    promotions: Record<string, { display_name: string; amount_eur: number; valid_days: number }>;
  };
  /** Solo en la web: de dónde se leyó (diagnóstico). */
  _source?: string;
};

export function idsFilePath() {
  return process.env.METRONOME_IDS_FILE || path.resolve(process.cwd(), "..", "metronome-setup", "metronome-ids.json");
}

const FIXED_ENV: Record<FixedProductKey, string> = {
  plan_credits: "METRONOME_PRODUCT_PLAN_CREDITS",
  bundle_commit: "METRONOME_PRODUCT_BUNDLE_COMMIT",
  bundle_bonus: "METRONOME_PRODUCT_BUNDLE_BONUS",
  auto_recharge: "METRONOME_PRODUCT_AUTO_RECHARGE",
  spend_threshold: "METRONOME_PRODUCT_SPEND_THRESHOLD",
  promo_credit: "METRONOME_PRODUCT_PROMO_CREDIT",
  enterprise_commit: "METRONOME_PRODUCT_ENTERPRISE_COMMIT",
};
const METRIC_ENV: Record<MetricId, string> = { input_tokens: "INPUT_TOKENS", output_tokens: "OUTPUT_TOKENS", images: "IMAGES" };

export function fromEnv(e: NodeJS.ProcessEnv): MetronomeIds {
  const m = <T>(f: (k: MetricId) => T) => ({ input_tokens: f("input_tokens"), output_tokens: f("output_tokens"), images: f("images") });
  return {
    generated_at: "", base_url: e.METRONOME_BASE_URL ?? "https://api.metronome.com", dry_run: false,
    credit_types: { EUR: e.METRONOME_CREDIT_TYPE_ID ?? "" },
    billable_metrics: m(k => e[`METRONOME_METRIC_${METRIC_ENV[k]}`] ?? ""),
    products: {
      usage: m(k => e[`METRONOME_PRODUCT_${METRIC_ENV[k]}`] ?? ""),
      subscription: { pro: e.METRONOME_PRODUCT_SUBSCRIPTION_PRO ?? "", scale: e.METRONOME_PRODUCT_SUBSCRIPTION_SCALE ?? "" },
      fixed: Object.fromEntries(Object.entries(FIXED_ENV).map(([k, v]) => [k, e[v] ?? ""])) as Record<FixedProductKey, string>,
    },
    rate_card: { id: e.METRONOME_RATE_CARD_ID ?? "", alias: "nebula_eur" },
    alerts: { zero_balance: e.METRONOME_ZERO_BALANCE_ALERT_ID, zero_balance_uniqueness_key: "nebula-zero-balance-eur-v1" },
    event_types: { input_tokens: "nebula_llm_request", output_tokens: "nebula_llm_request", images: "nebula_image_generation" },
    event_properties: { input_tokens: "input_tokens", output_tokens: "output_tokens", images: "images" },
    auto_recharge: { threshold_eur: AUTO_RECHARGE.threshold, recharge_to_eur: AUTO_RECHARGE.rechargeTo },
    spend_threshold: { scale_threshold_eur: SPEND_THRESHOLD.scaleThreshold },
    amount_scale: Number(e.METRONOME_AMOUNT_SCALE ?? 1) || 1,
    catalog: {
      plans: Object.fromEntries((Object.keys(PLANS) as PlanId[]).map(k => [k, { display_name: PLANS[k].name, monthly_fee_eur: PLANS[k].monthlyFee, monthly_credits_eur: PLANS[k].monthlyCredits, usage_multiplier: 1 - PLANS[k].discount }])) as MetronomeIds["catalog"]["plans"],
      bundles: Object.fromEntries(Object.values(BUNDLES).map(b => [b.id, { display_name: bundleDisplayName(b.id), paid_eur: b.price, bonus_eur: b.credit - b.price }])),
      promotions: Object.fromEntries(Object.entries(PROMOTIONS).map(([code, p]) => [code, { display_name: p.label, amount_eur: p.amount, valid_days: p.validDays }])),
    },
  };
}

/** Comprueba que están los IDs imprescindibles; devuelve la lista de claves que faltan. */
export function missingIds(ids: MetronomeIds): string[] {
  const miss: string[] = [];
  if (!ids.credit_types?.EUR) miss.push("credit_types.EUR");
  if (!ids.rate_card?.id) miss.push("rate_card.id");
  for (const k of ["input_tokens", "output_tokens", "images"] as MetricId[]) {
    if (!ids.products?.usage?.[k]) miss.push(`products.usage.${k}`);
    if (!ids.billable_metrics?.[k]) miss.push(`billable_metrics.${k}`);
  }
  for (const k of ["pro", "scale"] as SubscriptionPlanKey[]) if (!ids.products?.subscription?.[k]) miss.push(`products.subscription.${k}`);
  for (const k of Object.keys(FIXED_ENV) as FixedProductKey[]) if (!ids.products?.fixed?.[k]) miss.push(`products.fixed.${k}`);
  return miss;
}

let cache: { key: string; ids: MetronomeIds } | null = null;

export function loadMetronomeIds(): MetronomeIds {
  const file = idsFilePath();
  let fileIds: Partial<MetronomeIds> | undefined;
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
    if (cache && cache.key === `${file}:${mtime}`) return cache.ids;
    fileIds = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { fileIds = undefined; }
  const env = fromEnv(process.env);
  // Fusión superficial por secciones: el fichero manda; las variables de entorno rellenan huecos.
  const f = fileIds ?? {};
  const ids: MetronomeIds = {
    ...env, ...f,
    credit_types: { EUR: f.credit_types?.EUR || env.credit_types.EUR },
    billable_metrics: { ...env.billable_metrics, ...f.billable_metrics },
    products: {
      usage: { ...env.products.usage, ...f.products?.usage },
      subscription: { ...env.products.subscription, ...f.products?.subscription },
      fixed: { ...env.products.fixed, ...f.products?.fixed },
    },
    rate_card: { ...env.rate_card, ...f.rate_card },
    alerts: { ...env.alerts, ...f.alerts },
    event_types: { ...env.event_types, ...f.event_types },
    event_properties: { ...env.event_properties, ...f.event_properties },
    auto_recharge: { ...env.auto_recharge, ...f.auto_recharge },
    spend_threshold: { ...env.spend_threshold, ...f.spend_threshold },
    amount_scale: Number(f.amount_scale ?? env.amount_scale) || 1,
    // Catálogo: el fichero manda (display_name, promociones); el catálogo de la web rellena lo que falte (ficheros antiguos).
    catalog: {
      plans: Object.fromEntries((Object.keys(env.catalog.plans) as PlanId[]).map(k => [k, { ...env.catalog.plans[k], ...f.catalog?.plans?.[k] }])) as MetronomeIds["catalog"]["plans"],
      bundles: Object.fromEntries(Object.keys(env.catalog.bundles).map(k => [k, { ...env.catalog.bundles[k], ...f.catalog?.bundles?.[k] }])),
      promotions: f.catalog?.promotions && Object.keys(f.catalog.promotions).length ? f.catalog.promotions : env.catalog.promotions,
    },
    _source: fileIds ? file : "environment variables",
  };
  if (ids.dry_run) throw new Error(`${file} comes from a dry run (sample IDs). Run the real setup: cd ../metronome-setup && npm run setup`);
  const miss = missingIds(ids);
  if (miss.length) throw new Error(`Missing Metronome configuration: ${miss.join(", ")} (in ${file} or in environment variables)`);
  cache = { key: `${file}:${mtime}`, ids };
  return ids;
}

/** Nombre visible de un bundle, igual que el setup: "€50 bundle (+€5 bonus)". */
export function bundleDisplayName(id: BundleId) {
  const b = BUNDLES[id];
  return `€${b.price} bundle (+€${b.credit - b.price} bonus)`;
}

/** Promoción por código según metronome-ids.json (catalog.promotions); undefined si no existe. */
export function promotionFromIds(ids: MetronomeIds, rawCode: string) {
  const code = rawCode.trim().toUpperCase();
  const p = ids.catalog.promotions[code];
  return p ? { code, label: p.display_name, amount: p.amount_eur, validDays: p.valid_days, display: `${p.display_name} (${eur(p.amount_eur)}, ${p.valid_days} days)` } : undefined;
}

/** Nombre visible de un plan según metronome-ids.json (catalog.plans[].display_name). */
export const planDisplayName = (ids: MetronomeIds, plan: PlanId) => ids.catalog.plans[plan]?.display_name || PLANS[plan].name;
