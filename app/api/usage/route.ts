import { randomUUID } from "node:crypto";
import { billing } from "@/lib/billing";
import { withCustomer } from "@/lib/route";
import type { UsageRequest } from "@/lib/billing/types";

// Ingesta de uso: una entrada por petición de IA con su id (→ transaction_id en /v1/ingest; los reintentos se deduplican).
//   { requests: [{ requestId, inputTokens, outputTokens, images, model?, ts? }] }
// Con { simulate: true, requestId } genera una petición de IA falsa (generador de la demo).
export async function POST(req: Request) {
  const body = await req.json();
  let requests: UsageRequest[] = Array.isArray(body.requests) ? body.requests : [];
  if (body.simulate) {
    const scale = body.intensity ?? 1;
    const r = (min: number, max: number) => Math.round((min + Math.random() * (max - min)) * scale);
    const withImages = Math.random() < 0.35;
    requests = [{
      requestId: typeof body.requestId === "string" ? body.requestId : `req_${randomUUID()}`, source: "simulador" as const,
      ...(withImages ? { images: Math.max(1, r(1, 12)), model: "nebula-image-1" } : { inputTokens: r(20_000, 400_000), outputTokens: r(10_000, 250_000), model: "nebula-1" }),
    }];
  }
  requests = requests.filter(x => x && typeof x.requestId === "string" && x.requestId.length <= 128);
  return withCustomer(async cid => {
    const r = await billing.ingest(cid, requests);
    return { account: r.account, rejected: r.rejected, reason: r.reason, duplicates: r.duplicates };
  });
}
