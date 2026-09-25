// Stripe solo se usa para guardar la tarjeta (Checkout en modo "setup"). Los cobros los hace Metronome.
import Stripe from "stripe";

let _stripe: Stripe | null = null;
export const stripe = () => {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Falta STRIPE_SECRET_KEY");
  return (_stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY));
};
