import { billing } from "@/lib/billing";
import { withCustomer } from "@/lib/route";
export async function POST(req: Request) {
  const { enabled } = await req.json();
  return withCustomer(cid => billing.setAutoRecharge(cid, !!enabled));
}
