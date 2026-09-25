"use client";
import Link from "next/link";
import { PLANS, eur } from "@/lib/catalog";
import type { AccountView } from "./useAccount";

/** Vista previa de la próxima factura (UpcomingInvoicePreview; en vivo = facturas DRAFT de Metronome del periodo en curso). */
export default function UpcomingInvoice({ a }: { a: AccountView }) {
  const u = a.upcoming;
  if (!u) return null;
  const end = u.periodEnd ? new Date(u.periodEnd).toLocaleDateString("en-US", { day: "numeric", month: "long", timeZone: "UTC" }) : "month end";
  return (
    <div className="card">
      <div className="row"><h3 className="sp" style={{ margin: 0 }}>Next invoice</h3><span className="badge">estimate</span></div>
      <p className="muted" style={{ fontSize: 13 }}>Issued on {end}. Updates in real time with every request.</p>
      <div className="stat">{eur(u.totalDueEur)}</div>
      <div className="tablewrap" tabIndex={0}><table><tbody>
        {u.lines.length === 0 && <tr><td className="muted">No charges yet.</td></tr>}
        {u.lines.map((l, i) => (
          <tr key={i}><td>{l.name}</td><td style={{ textAlign: "right", whiteSpace: "nowrap" }} className={l.totalEur < 0 ? "okc" : ""}>{eur(l.totalEur)}</td></tr>
        ))}
        <tr><td className="muted">Gross charges · credits applied</td><td style={{ textAlign: "right", whiteSpace: "nowrap" }} className="muted">{eur(u.grossChargesEur)} · −{eur(u.creditsAppliedEur)}</td></tr>
      </tbody></table></div>
      {a.pendingPlan && <p className="muted" style={{ fontSize: 13 }}>Includes the {PLANS[a.pendingPlan.plan].name} fee (scheduled downgrade).</p>}
      {a.mode === "mock" && <Link href="/billing/invoices/draft-current" className="muted" style={{ fontSize: 13 }}><u>View usage draft</u></Link>}
    </div>
  );
}
