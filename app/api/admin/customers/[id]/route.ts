import { toPublic } from "@/lib/apikeys";
import { withAdmin } from "@/lib/admin";
import { billing } from "@/lib/billing";
import { view } from "@/lib/serialize";
import { getAdminLog, getPlanHistory, listApiKeys, read } from "@/lib/store";

export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: { id: string } }) {
  return withAdmin(async () => {
    const a = await billing.get(params.id);
    if (!a) throw new Error("Customer not found");
    const key = a.mode === "mock" ? a.customerId : read(db => db.links[a.customerId]?.metronomeCustomerId ?? a.customerId);
    return {
      account: view(a, true),
      planHistory: getPlanHistory(a.customerId),
      adminLog: getAdminLog(a.customerId).slice(0, 50),
      apiKeys: listApiKeys(a.customerId).map(toPublic),
      purchases: read(db => db.purchases.filter(p => p.customerKey === key)),
      link: a.mode === "metronome" ? read(db => { const l = db.links[a.customerId]; return l && { metronomeCustomerId: l.metronomeCustomerId, metronomeContractId: l.metronomeContractId, stripeCustomerId: l.stripeCustomerId }; }) : undefined,
    };
  });
}
