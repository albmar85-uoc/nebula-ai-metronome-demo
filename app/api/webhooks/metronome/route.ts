import { NextResponse } from "next/server";
import { isLive } from "@/lib/billing";
import { handleMetronomeEvent, verifyMetronomeSignature, type MetronomeEvent } from "@/lib/webhooks";

// Receptor de webhooks de Metronome (alertas de saldo, payment_gate.*). Verifica la firma con METRONOME_WEBHOOK_SECRET.
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
    return NextResponse.json({ error: "METRONOME_WEBHOOK_SECRET is not set" }, { status: 503 });
  }
  let ev: MetronomeEvent;
  try { ev = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  try {
    const r = await handleMetronomeEvent(ev, { verified });
    return NextResponse.json({ received: true, verified, ...r });
  } catch (e) {
    // 5xx ⇒ Metronome reintenta; el evento NO se marcó como visto.
    console.error("[webhook] error procesando", ev?.id, e);
    return NextResponse.json({ error: "Error processing the webhook" }, { status: 500 });
  }
}
