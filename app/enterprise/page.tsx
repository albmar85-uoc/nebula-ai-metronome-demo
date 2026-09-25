"use client";
import { useState } from "react";
import Link from "next/link";
import { METRICS, eur, type MetricId } from "@/lib/catalog";
import type { EnterpriseContractSummary } from "@/lib/billing/metronome-types";

type Proposal = EnterpriseContractSummary & { monthlyEquivalentEur: number; savingsVsListPct: number };
const unit = (m: MetricId) => (m === "images" ? "imagen" : "millón de tokens");
const list = (m: MetricId) => METRICS[m].pricePerUnit * (m === "images" ? 1 : 1_000_000);

export default function Enterprise() {
  const [f, setF] = useState({ company: "", email: "", monthlySpend: 2000 });
  const [p, setP] = useState<Proposal | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const r = await fetch("/api/enterprise", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Error");
      setP(d.proposal);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <main className="wrap narrow">
      <h2>nebula.ai Enterprise</h2>
      <p className="muted">Contrato anual con compromiso de gasto y precios negociados. Cuéntanos tu volumen y te preparamos una propuesta.</p>
      <div className="grid g2">
        <form className="card" onSubmit={submit}>
          <label className="f" htmlFor="c">Empresa</label>
          <input id="c" value={f.company} onChange={e => setF({ ...f, company: e.target.value })} required />
          <label className="f" htmlFor="e">Correo de trabajo</label>
          <input id="e" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required />
          <label className="f" htmlFor="s">Gasto mensual estimado: {eur(f.monthlySpend)}</label>
          <input id="s" type="range" min={500} max={20000} step={500} value={f.monthlySpend} onChange={e => setF({ ...f, monthlySpend: +e.target.value })} />
          {err && <div className="banner bad">{err}</div>}
          <button className="btn primary" style={{ width: "100%", marginTop: 14 }} disabled={busy}>{busy ? "Enviando…" : "Solicitar propuesta"}</button>
          <p className="muted" style={{ fontSize: 12 }}>Demo: la solicitud se guarda solo en local, no se envía a nadie.</p>
        </form>
        <div className="card">
          <h3>{p ? "Propuesta de ejemplo" : "Cómo funciona"}</h3>
          {!p && <ul className="clean">
            <li><b>Compromiso anual:</b> te comprometes a un gasto mínimo; el uso lo va consumiendo y al final del año solo se factura la diferencia si no llegas.</li>
            <li><b>Precios negociados</b> por métrica, por debajo de la tarifa pública.</li>
            <li><b>Pago a 30 días</b> con factura mensual del uso.</li>
          </ul>}
          {p && <>
            <div className="stat">{eur(p.commitAmountEur)} <small className="muted" style={{ fontSize: 14 }}>/ año</small></div>
            <p className="muted" style={{ fontSize: 13 }}>{p.commitType === "POSTPAID" ? "Gasto mínimo anual (true-up al final)" : "Prepago anual"} · equivale a {eur(p.monthlyEquivalentEur)}/mes · del {new Date(p.startingAt).toLocaleDateString("es-ES")} al {new Date(p.endingBefore).toLocaleDateString("es-ES")}</p>
            <div className="tablewrap"><table><thead><tr><th>Métrica</th><th>Tarifa pública</th><th>Tu precio</th></tr></thead><tbody>
              {p.rateOverrides.map(o => <tr key={o.metric}><td>{METRICS[o.metric].name}</td><td className="muted">{eur(list(o.metric))} / {unit(o.metric)}</td><td><b>{eur(o.priceEur)}</b> / {unit(o.metric)}</td></tr>)}
            </tbody></table></div>
            <p className="muted" style={{ fontSize: 13 }}>Ahorro medio frente a la tarifa: {p.savingsVsListPct} %. Nuestro equipo te contactará para ajustarla.</p>
          </>}
        </div>
      </div>
      <p className="sec"><Link href="/#precios" className="muted"><u>← Volver a precios</u></Link></p>
    </main>
  );
}
