"use client";
import Link from "next/link";
import { eur } from "@/lib/catalog";
import type { AccountView } from "./useAccount";

/** Scale: aviso del cobro anticipado por umbral de gasto (spend_threshold_configuration) para picos de uso. */
export default function SpendThresholdNotice({ a, compact }: { a: AccountView; compact?: boolean }) {
  if (a.plan !== "scale") return null;
  const st = a.spendThreshold;
  if (!st?.enabled) {
    return compact ? null : <div className="banner info">Early threshold charge is off: all overage is billed at month end.</div>;
  }
  const accrued = Math.max(0, a.overageAccrued - (a.spendPrepaid ?? 0));
  const pct = Math.min(100, (accrued / st.thresholdEur) * 100);
  return (
    <div className="banner info">
      <b>Spike protection:</b> every time your overage this month reaches {eur(st.thresholdEur)}, we charge it early to your card
      and deduct it from the month-end invoice. So far: {eur(accrued)} of {eur(st.thresholdEur)}{a.spendPrepaid ? ` (already charged early: ${eur(a.spendPrepaid)})` : ""}.
      <div className="bar" style={{ marginTop: 8 }}><i style={{ width: `${pct}%` }} /></div>
      {compact && <Link href="/billing" style={{ fontSize: 13 }}><u>Configure</u></Link>}
    </div>
  );
}
