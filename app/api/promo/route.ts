import { billing } from "@/lib/billing";
import { withCustomer } from "@/lib/route";
// Canje de código promocional (crédito gratuito con caducidad; una vez por cliente).
export async function POST(req: Request) {
  const { code } = await req.json();
  return withCustomer(cid => billing.redeemPromo(cid, String(code ?? "")));
}
