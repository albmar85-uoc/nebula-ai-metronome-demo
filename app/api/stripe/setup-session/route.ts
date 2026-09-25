import { NextResponse } from "next/server";
import { isStripeLive } from "@/lib/billing";
import { PLANS } from "@/lib/catalog";
import { stripe } from "@/lib/stripe";

// Paso 1 del alta en vivo: crea el cliente de Stripe y una sesión de Checkout en modo "setup"
// (solo guarda la tarjeta, no cobra). Al volver, /api/stripe/return crea el cliente y el contrato en Metronome.
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  if (!isStripeLive()) return NextResponse.json({ error: "Stripe Checkout is only enabled in live mode" }, { status: 400 });
  const { name, email, plan } = await req.json();
  if (!name || !email || !(plan in PLANS)) return NextResponse.json({ error: "Missing details" }, { status: 400 });
  const origin = process.env.APP_URL || new URL(req.url).origin;
  const customer = await stripe().customers.create({ name, email, metadata: { app: "nebula-demo", plan } });
  const session = await stripe().checkout.sessions.create({
    mode: "setup",
    currency: "eur", // obligatorio en modo setup si no se indican payment_method_types
    customer: customer.id,
    // Metronome necesita una dirección válida para cobrar commits con payment gate.
    billing_address_collection: "required",
    customer_update: { address: "auto", name: "auto" },
    locale: "es",
    metadata: { name, email, plan },
    success_url: `${origin}/api/stripe/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/signup?plan=${plan}&cancelled=1`,
  });
  return NextResponse.json({ url: session.url });
}
