"use client";
import Link from "next/link";
import { PLANS, eur } from "@/lib/catalog";
import type { AccountView } from "./useAccount";

/** Comparador: coste de tus últimos 30 días en cada plan (cuota + extra con descuento, créditos incluidos y forma de pago del extra). */
export default function PlanComparison({ a }: { a: AccountView }) {
  const r = a.recommendation;
  if (!r) return null;
  const best = r.estimates.find(e => e.plan === r.recommended)!;
  const save = r.savingsVsCurrentEur ?? 0;
  return (
    <section className="card" aria-labelledby="cmp-title">
      <div className="row"><h3 id="cmp-title" className="sp">Are you on the right plan?</h3>{r.projected && <span className="badge warn">projection from {r.observedDays} days of data</span>}</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        {r.observedDays === 0 ? "No usage in the last 30 days yet: once there is, we'll compare what you'd pay on each plan." :
          <>Your usage over the last 30 days{r.projected ? " (extrapolated to a month)" : ""} is worth {eur(r.monthlyListCostEur)} at list price. Here is what each plan would cost, including the fee, included credits, discount and how overage is paid.</>}
      </p>
      <div className="tablewrap" tabIndex={0}>
        <table>
          <caption className="sr-only">Estimated monthly cost per plan</caption>
          <thead><tr><th scope="col">Plan</th><th scope="col">Fee</th><th scope="col">Discounted usage</th><th scope="col">Included credits</th><th scope="col">Overage paid</th><th scope="col">Total / month</th><th scope="col">vs. your plan</th></tr></thead>
          <tbody>
            {r.estimates.map(e => (
              <tr key={e.plan} className={e.plan === a.plan ? "cur" : ""}>
                <th scope="row" style={{ fontWeight: 600 }}>{PLANS[e.plan].name} {e.plan === a.plan && <span className="badge acc">current</span>} {e.plan === r.recommended && r.observedDays > 0 && <span className="badge ok">best price</span>}</th>
                <td>{eur(e.monthlyFeeEur)}</td>
                <td>{eur(e.usageCostAfterDiscountEur)}</td>
                <td>{eur(e.includedCreditsEur)}</td>
                <td title={e.note}>{eur(e.extraPaidEur)}{e.coverage === "bundles" && <div className="muted" style={{ fontSize: 12 }}>via bundles</div>}{e.coverage === "overage" && <div className="muted" style={{ fontSize: 12 }}>at month end</div>}</td>
                <td><b>{eur(e.totalMonthlyEur)}</b></td>
                <td>{e.plan === a.plan ? "—" : (e.savingsVsCurrentEur ?? 0) > 0 ? <span className="okc">save {eur(e.savingsVsCurrentEur!)}</span> : <span className="muted">+{eur(-(e.savingsVsCurrentEur ?? 0))}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.observedDays > 0 && (r.recommended !== a.plan && save > 1
        ? <p style={{ marginBottom: 0 }}>With this usage, <b>{PLANS[r.recommended].name}</b> would save you about <b>{eur(save)}/month</b>. {best.note} <Link href="/billing"><u>Change plan</u></Link></p>
        : <p className="muted" style={{ marginBottom: 0 }}>Your current plan is the cheapest for this usage (or the difference is under €1).</p>)}
      {r.enterpriseHint && <p style={{ marginBottom: 0 }}>At this volume an <b>Enterprise</b> contract with an annual commit and negotiated prices makes sense. <Link href="/enterprise"><u>Contact sales</u></Link></p>}
    </section>
  );
}
