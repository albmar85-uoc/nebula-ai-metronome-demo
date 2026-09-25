"use client";
import Link from "next/link";
import { LOW_BALANCE_RATIO, PLANS, eur } from "@/lib/catalog";
import type { AccountView } from "./useAccount";

export default function Banners({ a }: { a: AccountView }) {
  const pending = a.pendingPlan && <div className="banner info">Cambio al plan {PLANS[a.pendingPlan.plan].name} programado para el {new Date(a.pendingPlan.effectiveAt).toLocaleDateString("es-ES", { timeZone: "UTC" })}.</div>;
  if (a.blocked) return <>{pending}<div className="banner bad">Tu saldo está a cero y el acceso a la API está en pausa. <Link href="/billing"><u>Recarga o sube de plan</u></Link> para seguir.</div></>;
  if (a.balance <= 0 && PLANS[a.plan].overage) return <>{pending}<div className="banner warn">Saldo agotado. Llevas {eur(a.overageAccrued)} de uso extra, que se facturará a fin de mes.</div></>;
  if (a.balance < PLANS[a.plan].monthlyCredits * LOW_BALANCE_RATIO) return <>{pending}<div className="banner warn">Te queda poco saldo ({eur(a.balance)}). <Link href="/billing"><u>Compra un bundle</u></Link>.</div></>;
  return pending || null;
}
