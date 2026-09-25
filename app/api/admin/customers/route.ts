import { withAdmin } from "@/lib/admin";
import { billing } from "@/lib/billing";
import { view } from "@/lib/serialize";
import { listCustomerKeys } from "@/lib/store";

export const dynamic = "force-dynamic";
/**
 * Lista de clientes para soporte. Simulado: todas las cuentas de db.json. En vivo: los clientes enlazados en la app;
 * cada fila consulta saldos/contrato en Metronome (each row uses the 10 s account cache; with many
 * customers, paginate or use /v1/customers + a balances report instead: fine for a demo with a handful of customers).
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.toLowerCase().trim() ?? "";
  return withAdmin(async () => {
    const ids = listCustomerKeys(billing.mode).slice(0, 200);
    const rows = [];
    for (const id of ids) {
      const a = await billing.get(id).catch(() => null);
      if (!a) continue;
      if (q && !`${a.name} ${a.email} ${a.customerId}`.toLowerCase().includes(q)) continue;
      const v = view(a);
      rows.push({ id: a.customerId, name: a.name, email: a.email, plan: a.plan, pendingPlan: a.pendingPlan, balance: v.balance, spent: v.spent, blocked: a.blocked, accessCut: !!a.accessCut, capReached: v.capReached, spendCap: a.spendCap?.monthlyEur, periodStart: a.periodStart });
    }
    return { mode: billing.mode, customers: rows };
  });
}
