import { NextResponse } from "next/server";
import { isLive, isStripeLive } from "@/lib/billing";
import { loadMetronomeIds } from "@/lib/billing/metronome-config";
import { PROMOTIONS } from "@/lib/catalog";

export const dynamic = "force-dynamic";
/** Modo de la demo y códigos promocionales visibles (en vivo: catalog.promotions de metronome-ids.json). */
export function GET() {
  let promotions = Object.entries(PROMOTIONS).map(([code, p]) => ({ code, label: p.label, amountEur: p.amount, validDays: p.validDays }));
  if (isLive()) {
    try { promotions = Object.entries(loadMetronomeIds().catalog.promotions).map(([code, p]) => ({ code, label: p.display_name, amountEur: p.amount_eur, validDays: p.valid_days })); }
    catch { /* sin IDs válidos: se muestra el catálogo de la web */ }
  }
  return NextResponse.json({ mode: isLive() ? "metronome" : "mock", stripeCheckout: isStripeLive(), promotions });
}
