import { billing } from "@/lib/billing";
import { withCustomer } from "@/lib/route";

/** { monthlyEur: number | null } — límite de gasto mensual del cliente (null = sin límite). */
export async function POST(req: Request) {
  const { monthlyEur } = await req.json();
  return withCustomer(cid => billing.setSpendCap(cid, monthlyEur === null || monthlyEur === "" ? null : Number(monthlyEur)));
}
