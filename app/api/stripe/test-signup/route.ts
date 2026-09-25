import { NextResponse } from "next/server";
import { billing, isStripeLive } from "@/lib/billing";
import { PLANS, type PlanId } from "@/lib/catalog";
import { COOKIE, COOKIE_OPTS } from "@/lib/session";
import { stripe } from "@/lib/stripe";
import { getLink } from "@/lib/store";

// Live verification helper: sign-up without the hosted Checkout page, using Stripe TEST payment methods
// (pm_card_visa, pm_card_authenticationRequired, …). Same result as /api/stripe/return: Stripe customer with a
// default payment method + address, then Metronome customer + plan contract.
// Only exists with a Stripe TEST key and LIVE_TEST_SIGNUP=1; names are always prefixed "Nebula demo".
export const dynamic = "force-dynamic";
const TEST_PMS = new Set(["pm_card_visa", "pm_card_mastercard", "pm_card_authenticationRequired", "pm_card_chargeDeclined", "pm_card_visa_chargeDeclinedInsufficientFunds"]);

export async function POST(req: Request) {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!isStripeLive() || !key.startsWith("sk_test_") || process.env.LIVE_TEST_SIGNUP !== "1") return NextResponse.json({ error: "Not available" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const plan = body.plan as PlanId;
  const testCard = String(body.testCard ?? "pm_card_visa");
  if (!(plan in PLANS)) return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  if (!TEST_PMS.has(testCard)) return NextResponse.json({ error: `testCard must be one of ${[...TEST_PMS].join(", ")}` }, { status: 400 });
  const raw = String(body.name ?? "customer").slice(0, 60);
  const name = raw.startsWith("Nebula demo") ? raw : `Nebula demo ${raw}`;
  const email = String(body.email ?? `nebula-demo+${Date.now()}@example.com`);
  try {
    const s = stripe();
    const customer = await s.customers.create({
      name, email, metadata: { app: "nebula-demo", plan, purpose: "live-verification" },
      address: { line1: "Calle Demo 1", city: "Madrid", postal_code: "28001", country: "ES" }, // Metronome payment gates need an address
    });
    const pm = await s.paymentMethods.attach(testCard, { customer: customer.id });
    await s.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
    const a = await billing.signup({ name, email, plan, stripeCustomerId: customer.id });
    const res = NextResponse.json({ customerId: a.customerId, metronomeCustomerId: getLink(a.customerId)?.metronomeCustomerId, metronomeContractId: getLink(a.customerId)?.metronomeContractId, stripeCustomerId: customer.id, paymentMethod: pm.id, plan });
    res.cookies.set(COOKIE, a.customerId, COOKIE_OPTS);
    return res;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
