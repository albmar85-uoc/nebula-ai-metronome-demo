import { NextResponse } from "next/server";
import { billing } from "@/lib/billing";
import { AUTO_RECHARGE_PLANS_ERROR, isAutoRechargeAllowed } from "@/lib/catalog";
import { currentCustomerId } from "@/lib/session";
import { withCustomer } from "@/lib/route";

export async function POST(req: Request) {
  const { enabled } = await req.json().catch(() => ({}));
  // API guard (the UI already disables the toggle): auto-recharge only on Pro and Scale, never Free. Turning it off is always allowed.
  const cid = currentCustomerId();
  if (enabled && cid) {
    const a = await billing.get(cid).catch(() => null);
    if (a && !isAutoRechargeAllowed(a.plan)) return NextResponse.json({ error: AUTO_RECHARGE_PLANS_ERROR, code: "plan_not_allowed" }, { status: 403 });
  }
  return withCustomer(id => billing.setAutoRecharge(id, !!enabled));
}
