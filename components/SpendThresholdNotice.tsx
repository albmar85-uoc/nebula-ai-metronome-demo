"use client";
import Link from "next/link";
import { eur } from "@/lib/catalog";
import type { AccountView } from "./useAccount";

/** Scale: aviso del cobro anticipado por umbral de gasto (spend_threshold_configuration) para picos de uso. */
export default function SpendThresholdNotice({ a, compact }: { a: AccountView; compact?: boolean }) {
  if (a.plan !== "scale") return null;
  const st = a.spendThreshold;
  if (!st?.enabled) {
    return compact ? null : <div className="banner info">Cobro anticipado por umbral desactivado: todo el uso extra se factura a fin de mes.</div>;
  }
  const accrued = Math.max(0, a.overageAccrued - (a.spendPrepaid ?? 0));
  const pct = Math.min(100, (accrued / st.thresholdEur) * 100);
  return (
    <div className="banner info">
      <b>Protección ante picos:</b> cada vez que tu uso extra del mes llegue a {eur(st.thresholdEur)}, lo cobramos por adelantado en tu tarjeta
      y se descuenta de la factura de fin de mes. Llevas {eur(accrued)} de {eur(st.thresholdEur)}{a.spendPrepaid ? ` (ya cobrado por adelantado: ${eur(a.spendPrepaid)})` : ""}.
      <div className="bar" style={{ marginTop: 8 }}><i style={{ width: `${pct}%` }} /></div>
      {compact && <Link href="/billing" style={{ fontSize: 13 }}><u>Configurar</u></Link>}
    </div>
  );
}
