"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Guard from "@/components/Guard";
import Banners from "@/components/Banners";
import ModeBadge from "@/components/ModeBadge";
import UsageChart from "@/components/UsageChart";
import LowBalanceModal from "@/components/LowBalanceModal";
import UpcomingInvoice from "@/components/UpcomingInvoice";
import SpendThresholdNotice from "@/components/SpendThresholdNotice";
import PlanComparison from "@/components/PlanComparison";
import { api, type AccountView } from "@/components/useAccount";
import { METRICS, PLANS, eur, type MetricId } from "@/lib/catalog";

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);
const KIND = {
  recurring: { label: "plan credit", cls: "" }, promo: { label: "promo", cls: "warn" }, goodwill: { label: "goodwill", cls: "ok" }, gift: { label: "gift", cls: "ok" }, commit: { label: "paid balance", cls: "acc" },
} as const;

function Dashboard({ a }: { a: AccountView }) {
  const [running, setRunning] = useState(false);
  const [intensity, setIntensity] = useState(1);
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function tick() {
    // Cada petición lleva su id (→ transaction_id en Metronome): si se reintenta, no se cobra dos veces.
    const r = await api("/api/usage", { simulate: true, intensity, requestId: `req_${crypto.randomUUID()}` });
    if (r.rejected) { setMsg(r.reason === "spend_cap" ? "Request rejected (402): you've reached your monthly spend limit." : "Request rejected (402): balance used up."); stop(); } else setMsg("");
  }
  function start() { setRunning(true); timer.current = setInterval(() => tick().catch(() => stop()), 900); }
  function stop() { setRunning(false); if (timer.current) clearInterval(timer.current); timer.current = null; }
  useEffect(() => () => stop(), []);

  const daily = a.daily ?? [];
  const inPeriod = daily.filter(d => d.day >= a.periodStart.slice(0, 10));
  const totals = (Object.keys(METRICS) as MetricId[]).map(m => {
    const ev = inPeriod.filter(u => u.metric === m);
    return { m, qty: ev.reduce((s, u) => s + u.quantity, 0), cost: ev.reduce((s, u) => s + u.cost, 0) };
  });
  const spent = totals.reduce((s, t) => s + t.cost, 0);
  const granted = a.credits.reduce((s, c) => s + c.amount, 0);
  const recent = [...a.usage].slice(0, 40).reverse();
  const max = Math.max(...recent.map(u => u.cost), 0.0001);
  const plan = PLANS[a.plan];
  const rec = a.recommendation;
  // Peticiones recientes agrupadas por id (= transaction_id): simulador o API pública con clave.
  const lastRequests = (() => {
    const map = new Map<string, { id: string; ts: string; source?: string; cost: number; parts: { metric: MetricId; quantity: number }[] }>();
    for (const u of a.usage) {
      const key = u.requestId ?? u.id;
      if (!map.has(key)) { if (map.size >= 6) break; map.set(key, { id: key, ts: u.ts, source: u.source, cost: 0, parts: [] }); }
      const r = map.get(key)!;
      r.cost += u.cost; r.parts.unshift({ metric: u.metric, quantity: u.quantity });
    }
    return [...map.values()];
  })();

  return (
    <main className="wrap">
      <div className="row"><h2 className="sp">Hi, {a.name}</h2><ModeBadge /></div>
      <Banners a={a} />
      <LowBalanceModal a={a} />
      <div className="grid g4">
        <div className="card"><div className="label">Available balance</div><div className="stat">{eur(a.balance)}</div><div className="bar" style={{ marginTop: 10 }}><i style={{ width: `${Math.min(100, (a.balance / Math.max(granted, 1)) * 100)}%` }} /></div></div>
        <div className="card"><div className="label">Spent this month</div><div className="stat">{eur(spent)}</div>
          {a.spendCap
            ? <><div className="bar" style={{ marginTop: 10 }} role="progressbar" aria-label="Spend against your monthly limit" aria-valuemin={0} aria-valuemax={a.spendCap.monthlyEur} aria-valuenow={Math.round(spent * 100) / 100} aria-valuetext={`${eur(spent)} of ${eur(a.spendCap.monthlyEur)}`}><i style={{ width: `${Math.min(100, (spent / a.spendCap.monthlyEur) * 100)}%`, background: a.capReached ? "var(--bad)" : undefined }} /></div><div className="muted" style={{ fontSize: 13, marginTop: 4 }}>Limit: {eur(a.spendCap.monthlyEur)}</div></>
            : <div className="muted" style={{ fontSize: 13 }}>{new Set(a.usage.filter(u => u.ts >= a.periodStart).map(u => u.requestId ?? u.id)).size} recent requests{a.mode === "metronome" && " · estimate"}</div>}
        </div>
        <div className="card"><div className="label">Plan</div><div className="stat">{plan.name}</div><div className="muted" style={{ fontSize: 13 }}>{plan.discount ? `${plan.discount * 100}% discount` : "No discount"}</div></div>
        <div className="card"><div className="label">Overage (month end)</div><div className="stat">{eur(Math.max(0, a.overageAccrued - (a.spendPrepaid ?? 0)))}</div><div className="muted" style={{ fontSize: 13 }}>{plan.overage ? "Billed at period close" : "Not available on your plan"}</div></div>
      </div>

      {a.plan === "scale" && <div className="sec"><SpendThresholdNotice a={a} compact /></div>}

      <div className="grid g2x sec">
        <div className="card">
          <h3>Usage over the last 30 days</h3>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>By day and metric. {a.mode === "metronome" ? "Quantities from Metronome (/v1/usage); cost estimated with your rates." : "Cost already includes your plan discount."}</p>
          <UsageChart usage30={a.usage30} daily={daily} />
          {rec && rec.observedDays > 0 && rec.recommended !== a.plan && (rec.savingsVsCurrentEur ?? 0) > 1 && (
            <div className="banner info" style={{ marginTop: 14, marginBottom: 0 }}>
              Based on your last 30 days, the <b>{PLANS[rec.recommended].name}</b> plan would cost you about {eur(rec.estimates.find(e => e.plan === rec.recommended)!.totalMonthlyEur)}/month
              (estimated saving: {eur(rec.savingsVsCurrentEur!)}/month). <a href="#cmp-title"><u>See comparison</u></a>
            </div>
          )}
        </div>
        <UpcomingInvoice a={a} />
      </div>

      <div className="sec"><PlanComparison a={a} /></div>

      <div className="grid g2 sec">
        <div className="card" data-tour="usage">
          <h3>Traffic simulator</h3>
          <p className="muted" style={{ fontSize: 14 }}>Generates fake requests and sends them to <code>/api/usage</code>, just like your backend would with Metronome. To call the API for real, create an <Link href="/keys"><u>API key</u></Link> and follow the <Link href="/docs"><u>docs</u></Link>.</p>
          <label className="f" htmlFor="intensity">Intensity: x{intensity}</label>
          <input id="intensity" type="range" min={1} max={20} value={intensity} aria-valuetext={`x${intensity}`} onChange={e => setIntensity(+e.target.value)} />
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => tick()} disabled={running}>Send 1 request</button>
            {running ? <button className="btn" onClick={stop}>Stop</button> : <button className="btn primary" onClick={start}>Continuous traffic</button>}
          </div>
          <div role="alert">{msg && <div className="banner bad" style={{ marginTop: 12 }}>{msg}</div>}</div>
          <div className="label" style={{ marginTop: 18 }}>Cost of the latest requests</div>
          <div className="chart" role="img" aria-label={`Cost of the latest ${recent.length} requests; max ${eur(max)}`}>{recent.map(u => <i key={u.id} title={eur(u.cost)} style={{ height: `${(u.cost / max) * 100}%` }} />)}</div>
        </div>
        <div className="card" data-tour="alerts">
          <h3>Alerts</h3>
          <p className="muted" style={{ fontSize: 13 }}>{a.mode === "metronome" ? "Delivered as Metronome webhooks." : "Generated locally; in production they arrive as Metronome webhooks."}</p>
          <div aria-live="polite" aria-relevant="additions">
          {a.alerts.length === 0 && <p className="muted">No alerts.</p>}
          {a.alerts.slice(0, 8).map(al => (
            <div key={al.id} className={`alert ${al.type}`}>
              <span className="muted" style={{ fontSize: 12 }}>{new Date(al.ts).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</span>
              {al.source === "webhook" && <span className={`badge ${al.verified ? "ok" : "warn"}`} style={{ marginLeft: 6 }}>{al.verified ? "signed webhook" : "unsigned webhook"}</span>}{al.type === "support" && <span className="badge sup" style={{ marginLeft: 6 }}>support</span>} · {al.message}
            </div>
          ))}
          </div>
        </div>
      </div>

      <div className="grid g2 sec">
        <div className="card">
          <h3>Usage by metric (this month)</h3>
          <div className="tablewrap" tabIndex={0}><table><thead><tr><th scope="col">Metric</th><th scope="col">Quantity</th><th scope="col">Cost</th></tr></thead>
            <tbody>{totals.map(t => <tr key={t.m}><td>{METRICS[t.m].name}</td><td>{fmt(t.qty)}</td><td>{eur(t.cost)}</td></tr>)}</tbody></table></div>
          <h3 className="sec" id="req-title">Latest requests</h3>
          <div className="tablewrap" tabIndex={0}><table aria-labelledby="req-title"><thead><tr><th scope="col">Request</th><th scope="col">Source</th><th scope="col">Details</th><th scope="col" style={{ textAlign: "right" }}>Cost</th></tr></thead>
            <tbody>{lastRequests.length === 0 ? <tr><td colSpan={4} className="muted">No requests yet.</td></tr> : lastRequests.map(r => (
              <tr key={r.id} data-testid="request-row"><td><code style={{ fontSize: 11 }}>{r.id.length > 24 ? `${r.id.slice(0, 24)}…` : r.id}</code><div className="muted" style={{ fontSize: 11 }}>{new Date(r.ts).toLocaleString("en-US", { dateStyle: "short", timeStyle: "medium" })}</div></td>
                <td>{r.source === "api" ? <span className="badge acc">API</span> : <span className="badge">{r.source === "simulator" ? "simulator" : "—"}</span>}</td>
                <td style={{ fontSize: 13 }}>{r.parts.map(p => `${fmt(p.quantity)} ${METRICS[p.metric].unit}${p.metric === "input_tokens" ? " in" : p.metric === "output_tokens" ? " out" : ""}`).join(" · ")}</td>
                <td style={{ textAlign: "right" }}>{eur(r.cost)}</td></tr>))}</tbody></table></div>
        </div>
        <div className="card">
          <h3>Balance breakdown</h3>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Used in this order: plan credits → promos → gifts → paid balance. Within each type, whatever expires first goes first.</p>
          <div className="tablewrap" tabIndex={0}><table><thead><tr><th scope="col">Source</th><th scope="col">Remaining</th></tr></thead>
            <tbody>{a.credits.filter(c => c.remaining > 0 || c.kind === "recurring").map(c => <tr key={c.id}><td>{c.label} <span className={`badge ${KIND[c.reference?.startsWith("goodwill:") ? "goodwill" : c.kind].cls}`}>{KIND[c.reference?.startsWith("goodwill:") ? "goodwill" : c.kind].label}</span>{c.expiresAt && <div className="muted" style={{ fontSize: 12 }}>expires {new Date(c.expiresAt).toLocaleDateString("en-US", { timeZone: "UTC" })}</div>}</td><td style={{ whiteSpace: "nowrap" }}>{eur(c.remaining)} / {eur(c.amount)}</td></tr>)}</tbody></table></div>
        </div>
      </div>
    </main>
  );
}

export default function Page() { return <Guard>{a => <Dashboard a={a} />}</Guard>; }
