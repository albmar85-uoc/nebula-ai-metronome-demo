import { NextResponse } from "next/server";
import { billing, isLive } from "@/lib/billing";
import { seedHistoryMock, usageCost } from "@/lib/billing/mock";
import { getAccount, saveAccount } from "@/lib/store";
import { PLANS, type MetricId } from "@/lib/catalog";
import { COOKIE, COOKIE_OPTS } from "@/lib/session";
import type { DailyUsage, UsageRequest } from "@/lib/billing/types";

// Crea una cuenta Pro de ejemplo con 30 días de consumo, un bundle comprado y entra directamente al panel.
// Solo en modo simulado: en vivo crearía clientes reales en Metronome.
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (isLive()) return NextResponse.redirect(new URL("/signup", req.url));
  const a = await billing.signup({ name: "Demo account", email: "demo@nebula.ai", plan: "pro" });
  await billing.buyBundle(a.customerId, "b50", `demo-${a.customerId}`);
  const day = 86400_000;
  const periodStart = +new Date(a.periodStart);
  const rand = (min: number, max: number) => Math.round(min + Math.random() * (max - min));
  // Histórico anterior al periodo actual (solo gráfica de 30 días; ya facturado).
  const history: DailyUsage[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * day);
    if (+d >= periodStart) continue;
    const q: [MetricId, number][] = [["input_tokens", rand(150_000, 700_000)], ["output_tokens", rand(50_000, 300_000)], ["images", rand(0, 6)]];
    for (const [metric, quantity] of q) if (quantity) history.push({ day: d.toISOString().slice(0, 10), metric, quantity, cost: usageCost(metric, quantity, PLANS.pro.discount) });
  }
  seedHistoryMock(a.customerId, history);
  // Periodo actual: peticiones reales (con id de petición) repartidas entre el día 1 y hoy.
  const requests: UsageRequest[] = [];
  const n = 40;
  for (let i = 0; i < n; i++) {
    const ts = new Date(periodStart + 3600_000 + ((Date.now() - periodStart - 7200_000) * i) / (n - 1)).toISOString();
    requests.push(i % 4 === 3
      ? { requestId: `demo-${a.customerId}-${i}`, images: rand(1, 5), ts }
      : { requestId: `demo-${a.customerId}-${i}`, inputTokens: rand(30_000, 220_000), outputTokens: rand(10_000, 90_000), ts });
  }
  await billing.ingest(a.customerId, requests);
  // El aviso del 20 % del alta (créditos prorrateados, antes de comprar el bundle) no aplica ya: se quita de la demo.
  const seeded = getAccount(a.customerId);
  if (seeded) { seeded.alerts = seeded.alerts.filter(al => al.type !== "low_balance"); saveAccount(seeded); }
  const res = NextResponse.redirect(new URL("/dashboard", req.url));
  res.cookies.set(COOKIE, a.customerId, COOKIE_OPTS);
  return res;
}
