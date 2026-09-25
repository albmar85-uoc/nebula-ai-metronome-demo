// Configuración de IDs de Metronome para el modo en vivo.
// Fuente principal: fichero JSON generado por el script de setup del experto de Metronome
//   ruta = $METRONOME_IDS_FILE  ||  ../metronome-setup/metronome-ids.json (relativa al cwd)
// Si falta un valor en el fichero se usa la variable de entorno equivalente (ver .env.example).
// El lector es tolerante con varias formas de clave (p. ej. products.usage.input_tokens o
// products.input_tokens) para poder reconciliar con el formato final del script sin tocar código.
import fs from "node:fs";
import path from "node:path";
import type { MetricId, PlanId } from "../catalog";

export type MetronomeIds = {
  source: string; // de dónde se leyó (para diagnóstico)
  creditTypeId: string; // tipo de crédito fiat EUR (obligatorio: sin él Metronome asume USD)
  rateCardId: string;
  eventTypes: Record<MetricId, string>; // event_type de /v1/ingest por métrica
  eventProperties: Record<MetricId, string>;
  usageProducts: Record<MetricId, string>;
  subscriptionProducts: Partial<Record<PlanId, string>>; // Free no tiene cuota
  recurringCreditProduct: string;
  giftCreditProduct: string;
  prepaidCommitProduct: string;
  autoRechargeProduct: string; // producto del commit que crea la recarga automática (por defecto, el del bundle)
  amountScale: number; // EUR = 1 (unidades enteras); USD = 100 (céntimos)
  rechargeToAmount: number; // "recargar hasta" en euros
  fromSetup: boolean; // el fichero lo generó metronome-setup (custom fields registrados)
  hasGlobalZeroAlert: boolean; // el setup ya crea la alerta global de saldo 0
  packages: Partial<Record<PlanId, string>>; // opcional: plantillas de plan como "packages" de Metronome
  thresholdDiscount: boolean; // aplicar discount_configuration a la recarga automática (feature flag en Metronome)
};

type Json = Record<string, unknown>;
const get = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Json)[k] : undefined), o);
const pick = (o: unknown, ...paths: string[]) => {
  for (const p of paths) { const v = get(o, p); if (typeof v === "string" && v) return v; if (v && typeof v === "object" && typeof (v as Json).id === "string") return (v as Json).id as string; }
  return undefined;
};

export function idsFilePath() {
  return process.env.METRONOME_IDS_FILE || path.resolve(process.cwd(), "..", "metronome-setup", "metronome-ids.json");
}

let cache: { mtime: number; ids: MetronomeIds } | null = null;

export function loadMetronomeIds(): MetronomeIds {
  const file = idsFilePath();
  let json: unknown = {};
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
    if (cache && cache.mtime === mtime) return cache.ids;
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    json = {};
  }
  const e = process.env;
  const req = (name: string, v: string | undefined) => {
    if (!v) throw new Error(`Falta configuración de Metronome: ${name} (en ${file} o en variables de entorno)`);
    return v;
  };
  const metric = (m: MetricId, envName: string) =>
    pick(json, `products.usage.${m}`, `products.${m}`, `usage_products.${m}`, `product_ids.${m}`) ?? e[envName];
  const ids: MetronomeIds = {
    source: mtime ? file : "variables de entorno",
    creditTypeId: req("credit_types.EUR / METRONOME_CREDIT_TYPE_ID", pick(json, "credit_types.EUR", "credit_type_id", "credit_types.eur", "credit_type.eur", "fiat_credit_type_id", "eur_credit_type_id") ?? e.METRONOME_CREDIT_TYPE_ID),
    rateCardId: req("rate_card_id / METRONOME_RATE_CARD_ID", pick(json, "rate_card_id", "rate_card", "rate_cards.default") ?? e.METRONOME_RATE_CARD_ID),
    // Por defecto, los del setup: nebula_llm_request {input_tokens, output_tokens} y nebula_image_generation {images}.
    eventTypes: {
      input_tokens: pick(json, "event_types.input_tokens", "event_types.llm_request") ?? e.METRONOME_EVENT_TYPE_LLM ?? "nebula_llm_request",
      output_tokens: pick(json, "event_types.output_tokens", "event_types.llm_request") ?? e.METRONOME_EVENT_TYPE_LLM ?? "nebula_llm_request",
      images: pick(json, "event_types.images", "event_types.image_generation") ?? e.METRONOME_EVENT_TYPE_IMAGES ?? "nebula_image_generation",
    },
    eventProperties: {
      input_tokens: pick(json, "event_properties.input_tokens", "events.properties.input_tokens") ?? "input_tokens",
      output_tokens: pick(json, "event_properties.output_tokens", "events.properties.output_tokens") ?? "output_tokens",
      images: pick(json, "event_properties.images", "events.properties.images") ?? "images",
    },
    usageProducts: {
      input_tokens: req("products.usage.input_tokens / METRONOME_PRODUCT_INPUT_TOKENS", metric("input_tokens", "METRONOME_PRODUCT_INPUT_TOKENS")),
      output_tokens: req("products.usage.output_tokens / METRONOME_PRODUCT_OUTPUT_TOKENS", metric("output_tokens", "METRONOME_PRODUCT_OUTPUT_TOKENS")),
      images: req("products.usage.images / METRONOME_PRODUCT_IMAGES", metric("images", "METRONOME_PRODUCT_IMAGES")),
    },
    subscriptionProducts: {
      pro: pick(json, "products.subscription.pro", "products.subscriptions.pro", "plans.pro.subscription_product_id") ?? e.METRONOME_PRODUCT_SUBSCRIPTION_PRO,
      scale: pick(json, "products.subscription.scale", "products.subscriptions.scale", "plans.scale.subscription_product_id") ?? e.METRONOME_PRODUCT_SUBSCRIPTION_SCALE,
    },
    recurringCreditProduct: req("products.recurring_credit / METRONOME_PRODUCT_RECURRING_CREDIT", pick(json, "products.fixed.plan_credits", "products.recurring_credit", "products.monthly_credit", "products.credits.recurring") ?? e.METRONOME_PRODUCT_RECURRING_CREDIT),
    giftCreditProduct: req("products.gift_credit / METRONOME_PRODUCT_GIFT_CREDIT", pick(json, "products.fixed.bundle_bonus", "products.gift_credit", "products.bonus_credit", "products.credits.gift") ?? e.METRONOME_PRODUCT_GIFT_CREDIT),
    prepaidCommitProduct: req("products.prepaid_commit / METRONOME_PRODUCT_PREPAID_COMMIT", pick(json, "products.fixed.bundle_commit", "products.prepaid_commit", "products.commit", "products.bundle_commit", "products.credits.commit") ?? e.METRONOME_PRODUCT_PREPAID_COMMIT),
    autoRechargeProduct: "",
    amountScale: Number(get(json, "amount_scale") ?? e.METRONOME_AMOUNT_SCALE ?? 1) || 1,
    rechargeToAmount: Number(get(json, "auto_recharge.recharge_to_eur") ?? e.METRONOME_RECHARGE_TO_EUR ?? 60) || 60,
    fromSetup: typeof get(json, "generated_at") === "string",
    hasGlobalZeroAlert: !!(pick(json, "alerts.zero_balance") || pick(json, "alerts.zero_balance_uniqueness_key")),
    packages: {
      free: pick(json, "plans.free.package_id", "packages.free") ?? e.METRONOME_PACKAGE_FREE,
      pro: pick(json, "plans.pro.package_id", "packages.pro") ?? e.METRONOME_PACKAGE_PRO,
      scale: pick(json, "plans.scale.package_id", "packages.scale") ?? e.METRONOME_PACKAGE_SCALE,
    },
    thresholdDiscount: get(json, "threshold_discount") === true || e.METRONOME_THRESHOLD_DISCOUNT === "1",
  };
  ids.autoRechargeProduct = pick(json, "products.fixed.auto_recharge", "products.auto_recharge") ?? e.METRONOME_PRODUCT_AUTO_RECHARGE ?? ids.prepaidCommitProduct;
  cache = { mtime, ids };
  return ids;
}
