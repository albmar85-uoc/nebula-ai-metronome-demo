import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { billing, isStripeLive } from "@/lib/billing";
import { PLANS, type PlanId } from "@/lib/catalog";
import { COOKIE, COOKIE_OPTS } from "@/lib/session";
import { stripe } from "@/lib/stripe";

// Paso 2 del alta en vivo: Stripe vuelve aquí tras guardar la tarjeta.
// 1) fija la tarjeta como método de pago por defecto (Metronome cobra con charge_automatically)
// 2) crea cliente + contrato en Metronome enlazados al cliente de Stripe y abre sesión.
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!isStripeLive()) return NextResponse.redirect(new URL("/signup", url));
  const id = url.searchParams.get("session_id");
  if (!id) return NextResponse.redirect(new URL("/signup?error=stripe", url));
  const s = await stripe().checkout.sessions.retrieve(id, { expand: ["setup_intent"] });
  const si = s.setup_intent as Stripe.SetupIntent | null;
  if (s.status !== "complete" || !si || si.status !== "succeeded" || !s.customer) return NextResponse.redirect(new URL("/signup?error=stripe", url));
  const customerId = typeof s.customer === "string" ? s.customer : s.customer.id;
  const pm = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
  if (pm) await stripe().customers.update(customerId, { invoice_settings: { default_payment_method: pm } });
  const { name, email, plan } = s.metadata ?? {};
  if (!name || !email || !plan || !(plan in PLANS)) return NextResponse.redirect(new URL("/signup?error=datos", url));
  // TODO: idempotencia si el usuario recarga esta URL (guardar session_id procesados).
  const a = await billing.signup({ name, email, plan: plan as PlanId, stripeCustomerId: customerId });
  const res = NextResponse.redirect(new URL("/dashboard", url));
  res.cookies.set(COOKIE, a.customerId, COOKIE_OPTS);
  return res;
}
