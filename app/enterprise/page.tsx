"use client";
import { useState } from "react";
import Link from "next/link";
import { METRICS, eur, type MetricId } from "@/lib/catalog";
import type { EnterpriseContractSummary } from "@/lib/billing/metronome-types";

type Proposal = EnterpriseContractSummary & { monthlyEquivalentEur: number; savingsVsListPct: number };
const unit = (m: MetricId) => (m === "images" ? "image" : "million tokens");
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
      <p className="muted">Annual contract with a spend commitment and negotiated prices. Tell us your volume and we'll prepare a proposal.</p>
      <div className="grid g2">
        <form className="card" onSubmit={submit}>
          <label className="f" htmlFor="c">Company</label>
          <input id="c" value={f.company} onChange={e => setF({ ...f, company: e.target.value })} required />
          <label className="f" htmlFor="e">Work email</label>
          <input id="e" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required />
          <label className="f" htmlFor="s">Estimated monthly spend: {eur(f.monthlySpend)}</label>
          <input id="s" type="range" min={500} max={20000} step={500} value={f.monthlySpend} onChange={e => setF({ ...f, monthlySpend: +e.target.value })} />
          <div role="alert">{err && <div className="banner bad">{err}</div>}</div>
          <button className="btn primary" style={{ width: "100%", marginTop: 14 }} disabled={busy}>{busy ? "Sending…" : "Request a proposal"}</button>
          <p className="muted" style={{ fontSize: 12 }}>Demo: the request is only stored locally and is not sent to anyone.</p>
        </form>
        <div className="card">
          <h3>{p ? "Sample proposal" : "How it works"}</h3>
          {!p && <ul className="clean">
            <li><b>Annual commitment:</b> you commit to a minimum spend; usage draws it down and at year end only the shortfall is billed if you fall short.</li>
            <li><b>Negotiated prices</b> per metric, below the public rate card.</li>
            <li><b>Net 30 payment</b> with a monthly usage invoice.</li>
          </ul>}
          {p && <>
            <div className="stat">{eur(p.commitAmountEur)} <small className="muted" style={{ fontSize: 14 }}>/ year</small></div>
            <p className="muted" style={{ fontSize: 13 }}>{p.commitType === "POSTPAID" ? "Annual minimum spend (true-up at the end)" : "Annual prepayment"} · equivalent to {eur(p.monthlyEquivalentEur)}/month · from {new Date(p.startingAt).toLocaleDateString("en-US")} to {new Date(p.endingBefore).toLocaleDateString("en-US")}</p>
            <div className="tablewrap" tabIndex={0}><table><thead><tr><th scope="col">Metric</th><th scope="col">Public rate</th><th scope="col">Your price</th></tr></thead><tbody>
              {p.rateOverrides.map(o => <tr key={o.metric}><td>{METRICS[o.metric].name}</td><td className="muted">{eur(list(o.metric))} / {unit(o.metric)}</td><td><b>{eur(o.priceEur)}</b> / {unit(o.metric)}</td></tr>)}
            </tbody></table></div>
            <p className="muted" style={{ fontSize: 13 }}>Average saving vs. the rate card: {p.savingsVsListPct}%. Our team will contact you to fine-tune it.</p>
          </>}
        </div>
      </div>
      <p className="sec"><Link href="/#pricing" className="muted"><u>← Back to pricing</u></Link></p>
    </main>
  );
}
