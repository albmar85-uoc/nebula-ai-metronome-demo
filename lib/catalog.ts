// Catálogo de la demo. Todas las cifras son de ejemplo.
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
  monthlyFee: number;
  monthlyCredits: number;
  discount: number; // descuento sobre el uso
  overage: boolean; // si puede pasarse del saldo y pagar a fin de mes
  autoRechargeAllowed: boolean;
  features: string[];
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free", name: "Free", monthlyFee: 0, monthlyCredits: 5, discount: 0, overage: false, autoRechargeAllowed: false,
    features: ["5 € de créditos al mes", "Los créditos no se acumulan", "El acceso se corta al agotar el saldo"],
  },
  pro: {
    id: "pro", name: "Pro", monthlyFee: 29, monthlyCredits: 30, discount: 0.1, overage: false, autoRechargeAllowed: true,
    features: ["30 € de créditos al mes", "10 % de descuento en el uso", "Recarga automática opcional"],
  },
  scale: {
    id: "scale", name: "Scale", monthlyFee: 199, monthlyCredits: 250, discount: 0.2, overage: true, autoRechargeAllowed: true,
    features: ["250 € de créditos al mes", "20 % de descuento en el uso", "El exceso se factura a fin de mes"],
  },
};

export type BundleId = "b50" | "b200" | "b1000";
export const BUNDLES: Record<BundleId, { id: BundleId; price: number; credit: number }> = {
  b50: { id: "b50", price: 50, credit: 55 },
  b200: { id: "b200", price: 200, credit: 230 },
  b1000: { id: "b1000", price: 1000, credit: 1200 },
};

export const AUTO_RECHARGE = { threshold: 10, bundle: "b50" as BundleId };
export const LOW_BALANCE_RATIO = 0.2;

export const eur = (n: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: n !== 0 && Math.abs(n) < 0.1 ? 4 : 2 }).format(n);
