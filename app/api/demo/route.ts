import { NextResponse } from "next/server";
import { billing, isLive } from "@/lib/billing";
import { COOKIE, COOKIE_OPTS } from "@/lib/session";
import type { IngestEvent } from "@/lib/billing/types";

// Crea una cuenta Pro de ejemplo con consumo de los últimos días y entra directamente al panel.
// Solo en modo simulado: en vivo crearía clientes reales en Metronome.
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (isLive()) return NextResponse.redirect(new URL("/signup", req.url));
  const a = await billing.signup({ name: "Cuenta demo", email: "demo@nebula.ai", plan: "pro" });
  const day = 24 * 3600 * 1000;
  const monthStart = new Date(a.periodStart).getTime();
  for (let i = 11; i >= 0; i--) {
    // Reparte 12 peticiones en los últimos días (sin salir del mes en curso).
    const ts = new Date(Math.max(monthStart + 3600_000, Date.now() - i * day * 0.9 - Math.random() * 3600_000)).toISOString();
    const ev: IngestEvent[] = [
      { metric: "input_tokens", quantity: 50_000 + Math.round(Math.random() * 400_000), ts },
      { metric: "output_tokens", quantity: 20_000 + Math.round(Math.random() * 200_000), ts },
    ];
    if (i % 3 === 0) ev.push({ metric: "images", quantity: 1 + Math.round(Math.random() * 8), ts });
    await billing.ingest(a.customerId, ev);
  }
  const res = NextResponse.redirect(new URL("/dashboard", req.url));
  res.cookies.set(COOKIE, a.customerId, COOKIE_OPTS);
  return res;
}
