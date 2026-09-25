import { billing } from "@/lib/billing";
import { withCustomer } from "@/lib/route";
export async function POST(req: Request) {
  const { bundle } = await req.json();
  return withCustomer(cid => billing.buyBundle(cid, bundle));
}
