import { NextResponse } from "next/server";
import { isLive } from "@/lib/billing";
import { releasePendingGift } from "@/lib/billing/metronome";
import { handleMetronomeEvent, verifyMetronomeSignature, type MetronomeEvent } from "@/lib/webhooks";

// Receptor de webhooks de Metronome (alerts.low_remaining_contract_credit_and_commit_balance_reached,
// payment_gate.payment_status, ...). Verifica la firma con METRONOME_WEBHOOK_SECRET.
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const raw = await req.text(); // bytes exactos: la firma se calcula sobre el cuerpo sin re-serializar
  const secret = process.env.METRONOME_WEBHOOK_SECRET;
  let verified = false;
  if (secret) {
    const v = verifyMetronomeSignature(raw, req.headers, secret);
    if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 401 });
    verified = true;
  } else if (isLive()) {
    return NextResponse.json({ error: "Falta METRONOME_WEBHOOK_SECRET" }, { status: 503 });
  }
  let ev: MetronomeEvent;
  try { ev = JSON.parse(raw); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const r = await handleMetronomeEvent(ev, { verified, onPaymentPaid: isLive() ? releasePendingGift : undefined });
  return NextResponse.json({ received: true, verified, ...r });
}
