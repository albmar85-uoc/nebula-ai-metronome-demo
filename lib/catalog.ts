// Catálogo de la demo. Todas las cifras son de ejemplo.
// Alineado con /workspace/metronome-setup/src/config.ts (PLANS, BUNDLES, AUTO_RECHARGE, SPEND_THRESHOLD, PRIORITIES).
export type MetricId = "input_tokens" | "output_tokens" | "images";
export type PlanId = "free" | "pro" | "scale";

export const METRICS: Record<MetricId, { name: string; unit: string; pricePerUnit: number; display: string }> = {
  input_tokens: { name: "Tokens de entrada", unit: "tokens", pricePerUnit: 2 / 1_000_000, display: "2 € / millón" },
  output_tokens: { name: "Tokens de salida", unit: "tokens", pricePerUnit: 8 / 1_000_000, display: "8 € / millón" },
  images: { name: "Imágenes generadas", unit: "imágenes", pricePerUnit: 0.04, display: "0,04 € / imagen" },
};

export type Plan = {
  id: PlanId;
  name: string;
  rank: number; // para decidir subida (prorrateo inmediato) o bajada (siguiente periodo)
  monthlyFee: number;
  monthlyCredits: number;
  discount: number; // descuento sobre el uso
  overage: boolean; // si puede pasarse del saldo y pagar a fin de mes
  autoRechargeAllowed: boolean;
  features: string[];
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free", name: "Free", rank: 0, monthlyFee: 0, monthlyCredits: 5, discount: 0, overage: false, autoRechargeAllowed: false,
    features: ["5 € de créditos al mes", "Los créditos no se acumulan", "El acceso se corta al agotar el saldo"],
  },
  pro: {
    id: "pro", name: "Pro", rank: 1, monthlyFee: 29, monthlyCredits: 30, discount: 0.1, overage: false, autoRechargeAllowed: true,
    features: ["30 € de créditos al mes", "10 % de descuento en el uso", "Recarga automática opcional"],
  },
  scale: {
    id: "scale", name: "Scale", rank: 2, monthlyFee: 199, monthlyCredits: 250, discount: 0.2, overage: true, autoRechargeAllowed: true,
    features: ["250 € de créditos al mes", "20 % de descuento en el uso", "El exceso se factura a fin de mes", "Cobro anticipado si hay un pico de gasto"],
  },
};

export type BundleId = "b50" | "b200" | "b1000";
export const BUNDLES: Record<BundleId, { id: BundleId; price: number; credit: number; validityMonths: number }> = {
  b50: { id: "b50", price: 50, credit: 55, validityMonths: 12 },
  b200: { id: "b200", price: 200, credit: 230, validityMonths: 12 },
  b1000: { id: "b1000", price: 1000, credit: 1200, validityMonths: 12 },
};

/** Recarga automática = prepaid_balance_threshold_configuration: si el saldo baja de 10 €, recargar HASTA 50 € (sin regalo). */
export const AUTO_RECHARGE = { threshold: 10, rechargeTo: 50, validityMonths: 12 };
/** Scale: spend_threshold_configuration. Cada vez que el gasto extra del periodo llega a 300 €, se cobra por adelantado. */
export const SPEND_THRESHOLD = { scaleThreshold: 300 };
export const LOW_BALANCE_RATIO = 0.2;

/** Prioridad de consumo (menor = antes), igual que PRIORITIES del setup. */
export const PRIORITIES = { planCredits: 1, promo: 3, bundleBonus: 5, bundleCommit: 10, autoRecharge: 10, spendThreshold: 10, enterpriseCommit: 20 } as const;

/**
 * Códigos promocionales (créditos gratuitos con caducidad). Los valida la web; en vivo se envían a grantPromoCredit
 * con amountEur/validDays explícitos (el setup trae WELCOME y LAUNCH2026 con los mismos importes).
 */
export const PROMOTIONS: Record<string, { amount: number; validDays: number; label: string; setupCode: string }> = {
  BIENVENIDA10: { amount: 10, validDays: 30, label: "Bono de bienvenida", setupCode: "WELCOME" },
  LANZAMIENTO25: { amount: 25, validDays: 60, label: "Campaña de lanzamiento", setupCode: "LAUNCH2026" },
};

/** Ejemplo de propuesta Enterprise (se negocia por cliente). Forma: EnterpriseContractTerms del setup. */
export const ENTERPRISE_EXAMPLE = {
  termMonths: 12,
  commitAmountEur: 24_000,
  commitType: "POSTPAID" as const,
  rateOverrides: [
    { metric: "input_tokens" as MetricId, priceEur: 1.6 }, // € por millón
    { metric: "output_tokens" as MetricId, priceEur: 6.4 },
    { metric: "images" as MetricId, priceEur: 0.03 },
  ],
  netPaymentTermsDays: 30,
};

export const eur = (n: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: n !== 0 && Math.abs(n) < 0.1 ? 4 : 2 }).format(n);
