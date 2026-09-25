import { NextResponse } from "next/server";
import { isLive, isStripeLive } from "@/lib/billing";

export const dynamic = "force-dynamic";
export function GET() {
  return NextResponse.json({ mode: isLive() ? "metronome" : "mock", stripeCheckout: isStripeLive() });
}
