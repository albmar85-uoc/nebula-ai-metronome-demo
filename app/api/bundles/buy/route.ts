import { randomUUID } from "node:crypto";
import { billing } from "@/lib/billing";
import { withCustomer } from "@/lib/route";

// Compra de bundle. El id de compra lo genera el navegador una vez por clic (cabecera Idempotency-Key o body.purchaseId):
// es la base de las uniqueness_key deterministas (nebula-bundle-<id>, nebula-bonus-<id>) → los reintentos no duplican.
const VALID = /^[A-Za-z0-9_-]{8,64}$/;
export async function POST(req: Request) {
  const body = await req.json();
  const given = req.headers.get("idempotency-key") ?? body.purchaseId;
  const purchaseId = typeof given === "string" && VALID.test(given) ? given : `pur_${randomUUID()}`; // respaldo para llamadas sin id (curl)
  return withCustomer(cid => billing.buyBundle(cid, body.bundle, purchaseId));
}
