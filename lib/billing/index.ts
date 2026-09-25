import { mockBilling } from "./mock";
import { metronomeBilling } from "./metronome";

/** Modo en vivo solo si hay token Y se activa explícitamente (evita llamadas reales por descuido). */
export const isLive = () => !!(process.env.METRONOME_API_TOKEN || process.env.METRONOME_API_KEY) && process.env.METRONOME_LIVE === "1";
/** Stripe Checkout real solo en modo en vivo y con clave secreta. */
export const isStripeLive = () => isLive() && !!process.env.STRIPE_SECRET_KEY;

export const billing = isLive() ? metronomeBilling : mockBilling;
