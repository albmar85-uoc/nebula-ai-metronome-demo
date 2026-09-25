import { logAdmin, withAdmin } from "@/lib/admin";
import { billing } from "@/lib/billing";
import { PLANS, type PlanId } from "@/lib/catalog";
import { view } from "@/lib/serialize";

/** Cambio de plan hecho por soporte: mismas reglas que el cliente (subida inmediata prorrateada, bajada al siguiente periodo). */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { plan } = await req.json().catch(() => ({}));
  return withAdmin(async () => {
    if (!(plan in PLANS)) throw new Error("Unknown plan");
    const before = await billing.get(params.id);
    if (!before) throw new Error("Customer not found");
    const a = await billing.changePlan(params.id, plan as PlanId, "support");
    logAdmin(params.id, "plan_change", `${PLANS[before.plan].name} → ${PLANS[plan as PlanId].name}${a.pendingPlan ? ` (scheduled for ${a.pendingPlan.effectiveAt.slice(0, 10)})` : ""}`);
    return { account: view(a) };
  });
}
