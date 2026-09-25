"use client";
import Link from "next/link";
import { PLANS, eur } from "@/lib/catalog";
import type { AccountView } from "./useAccount";

/** Vista previa de la próxima factura (UpcomingInvoicePreview; en vivo = facturas DRAFT de Metronome del periodo en curso). */
export default function UpcomingInvoice({ a }: { a: AccountView }) {
  const u = a.upcoming;
  if (!u) return null;
  const end = u.periodEnd ? new Date(u.periodEnd).toLocaleDateString("es-ES", { day: "numeric", month: "long", timeZone: "UTC" }) : "fin de mes";
  return (
    <div className="card">
      <div className="row"><h3 className="sp" style={{ margin: 0 }}>Próxima factura</h3><span className="badge">estimada</span></div>
      <p className="muted" style={{ fontSize: 13 }}>Se emite el {end}. Se actualiza en tiempo real con cada petición.</p>
      <div className="stat">{eur(u.totalDueEur)}</div>
      <div className="tablewrap"><table><tbody>
        {u.lines.length === 0 && <tr><td className="muted">Sin cargos todavía.</td></tr>}
        {u.lines.map((l, i) => (
          <tr key={i}><td>{l.name}</td><td style={{ textAlign: "right", whiteSpace: "nowrap" }} className={l.totalEur < 0 ? "okc" : ""}>{eur(l.totalEur)}</td></tr>
        ))}
        <tr><td className="muted">Cargos brutos · créditos aplicados</td><td style={{ textAlign: "right", whiteSpace: "nowrap" }} className="muted">{eur(u.grossChargesEur)} · −{eur(u.creditsAppliedEur)}</td></tr>
      </tbody></table></div>
      {a.pendingPlan && <p className="muted" style={{ fontSize: 13 }}>Incluye la cuota de {PLANS[a.pendingPlan.plan].name} (bajada programada).</p>}
      {a.mode === "mock" && <Link href="/billing/invoices/draft-current" className="muted" style={{ fontSize: 13 }}><u>Ver borrador de uso</u></Link>}
    </div>
  );
}
