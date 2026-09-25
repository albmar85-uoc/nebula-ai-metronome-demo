import { logAdmin, withAdmin } from "@/lib/admin";
import { billing } from "@/lib/billing";
import { view } from "@/lib/serialize";

export async function POST(_: Request, { params }: { params: { id: string } }) {
  return withAdmin(async () => {
    const a = await billing.unblock(params.id);
    logAdmin(params.id, "unblock", a.blocked ? "Block lifted; still no balance" : "Access re-enabled");
    return { account: view(a) };
  });
}
