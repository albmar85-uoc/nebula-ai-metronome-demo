import { billing } from "@/lib/billing";
import { withCustomer } from "@/lib/route";
export async function POST(req: Request) {
  const { plan } = await req.json();
  return withCustomer(cid => billing.changePlan(cid, plan));
}
