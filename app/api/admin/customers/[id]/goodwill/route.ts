import { randomUUID } from "node:crypto";
import { logAdmin, withAdmin } from "@/lib/admin";
import { billing } from "@/lib/billing";
import { eur } from "@/lib/catalog";
import { view } from "@/lib/serialize";

/** { amountEur, reason, validDays?, grantId? } — grantId hace la concesión idempotente (doble clic, reintentos). */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  return withAdmin(async () => {
    const amountEur = Math.round(Number(body.amountEur) * 100) / 100;
    const reason = String(body.reason ?? "").trim().slice(0, 140);
    if (!reason) throw new Error("Enter a reason (it is logged and shown to the customer)");
    const validDays = Math.min(365, Math.max(1, Number(body.validDays) || 90));
    const grantId = typeof body.grantId === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(body.grantId) ? body.grantId : randomUUID();
    const a = await billing.grantGoodwill(params.id, { grantId, amountEur, reason, validDays });
    logAdmin(params.id, "goodwill_credit", `${eur(amountEur)} · ${validDays} days · ${reason} (grant ${grantId})`);
    return { account: view(a) };
  });
}
