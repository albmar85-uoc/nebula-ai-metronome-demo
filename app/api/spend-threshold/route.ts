import { billing } from "@/lib/billing";
import { withCustomer } from "@/lib/route";
// Scale: activar/desactivar el cobro anticipado por umbral de gasto (spend_threshold_configuration).
export async function POST(req: Request) {
  const { enabled } = await req.json();
  return withCustomer(cid => billing.setSpendThreshold(cid, !!enabled));
}
