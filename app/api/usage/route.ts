import { billing } from "@/lib/billing";
import { withCustomer } from "@/lib/route";
import type { MetricId } from "@/lib/catalog";

// Recibe eventos de uso. Con {simulate:true} genera una petición de IA falsa (generador de la demo).
export async function POST(req: Request) {
  const body = await req.json();
  let events: { metric: MetricId; quantity: number }[] = body.events ?? [];
  if (body.simulate) {
    const scale = body.intensity ?? 1;
    const r = (min: number, max: number) => Math.round((min + Math.random() * (max - min)) * scale);
    events = [
      { metric: "input_tokens", quantity: r(20_000, 400_000) },
      { metric: "output_tokens", quantity: r(10_000, 250_000) },
    ];
    if (Math.random() < 0.5) events.push({ metric: "images", quantity: Math.max(1, r(1, 12)) });
  }
  return withCustomer(async cid => {
    const r = await billing.ingest(cid, events);
    return { account: r.account, rejected: r.rejected };
  });
}
