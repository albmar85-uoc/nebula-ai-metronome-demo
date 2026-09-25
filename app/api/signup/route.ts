import { NextResponse } from "next/server";
import { billing, isStripeLive } from "@/lib/billing";
import { PLANS, type PlanId } from "@/lib/catalog";
import { COOKIE, COOKIE_OPTS } from "@/lib/session";
import { view } from "@/lib/serialize";

// Alta en modo simulado (tarjeta simulada). En vivo el alta pasa por /api/stripe/setup-session.
export async function POST(req: Request) {
  if (isStripeLive()) return NextResponse.json({ error: "In live mode, sign-up goes through Stripe Checkout" }, { status: 400 });
  const { name, email, plan } = await req.json();
  if (!name || !email || !(plan in PLANS)) return NextResponse.json({ error: "Missing details" }, { status: 400 });
  try {
    const a = await billing.signup({ name, email, plan: plan as PlanId });
    const res = NextResponse.json(view(a));
    res.cookies.set(COOKIE, a.customerId, COOKIE_OPTS);
    return res;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
