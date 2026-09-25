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
import { api, type AccountView } from "@/components/useAccount";
import { METRICS, PLANS, eur, type MetricId } from "@/lib/catalog";

const fmt = (n: number) => new Intl.NumberFormat("es-ES").format(n);
const KIND = {
  recurring: { label: "crédito del plan", cls: "" }, promo: { label: "promoción", cls: "warn" }, gift: { label: "regalo", cls: "ok" }, commit: { label: "saldo pagado", cls: "acc" },
} as const;

function Dashboard({ a }: { a: AccountView }) {
  const [running, setRunning] = useState(false);
  const [intensity, setIntensity] = useState(1);
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function tick() {
    // Cada petición lleva su id (→ transaction_id en Metronome): si se reintenta, no se cobra dos veces.
    const r = await api("/api/usage", { simulate: true, intensity, requestId: `req_${crypto.randomUUID()}` });
    if (r.rejected) { setMsg("Petición rechazada: saldo agotado."); stop(); } else setMsg("");
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

  return (
    <main className="wrap">
      <div className="row"><h2 className="sp">Hola, {a.name}</h2><ModeBadge /></div>
      <Banners a={a} />
      <LowBalanceModal a={a} />
      <div className="grid g4">
        <div className="card"><div className="label">Saldo disponible</div><div className="stat">{eur(a.balance)}</div><div className="bar" style={{ marginTop: 10 }}><i style={{ width: `${Math.min(100, (a.balance / Math.max(granted, 1)) * 100)}%` }} /></div></div>
        <div className="card"><div className="label">Gastado este mes</div><div className="stat">{eur(spent)}</div><div className="muted" style={{ fontSize: 13 }}>{new Set(a.usage.filter(u => u.ts >= a.periodStart).map(u => u.requestId ?? u.id)).size} peticiones recientes{a.mode === "metronome" && " · estimado"}</div></div>
        <div className="card"><div className="label">Plan</div><div className="stat">{plan.name}</div><div className="muted" style={{ fontSize: 13 }}>{plan.discount ? `${plan.discount * 100} % de descuento` : "Sin descuento"}</div></div>
        <div className="card"><div className="label">Uso extra (fin de mes)</div><div className="stat">{eur(Math.max(0, a.overageAccrued - (a.spendPrepaid ?? 0)))}</div><div className="muted" style={{ fontSize: 13 }}>{plan.overage ? "Se factura al cierre" : "No disponible en tu plan"}</div></div>
      </div>

      {a.plan === "scale" && <div className="sec"><SpendThresholdNotice a={a} compact /></div>}

      <div className="grid g2x sec">
        <div className="card">
          <h3>Uso de los últimos 30 días</h3>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Por día y métrica. {a.mode === "metronome" ? "Cantidades de Metronome (/v1/usage); coste estimado con tu tarifa." : "Coste ya con el descuento de tu plan."}</p>
          <UsageChart usage30={a.usage30} daily={daily} />
          {rec && rec.recommended !== a.plan && (rec.savingsVsCurrentEur ?? 0) > 1 && (
            <div className="banner info" style={{ marginTop: 14, marginBottom: 0 }}>
              Con tu uso de los últimos 30 días, el plan <b>{PLANS[rec.recommended].name}</b> te saldría por unos {eur(rec.estimates.find(e => e.plan === rec.recommended)!.totalMonthlyEur)}/mes
              (ahorro estimado: {eur(rec.savingsVsCurrentEur!)}/mes). <Link href="/billing"><u>Cambiar de plan</u></Link>
            </div>
          )}
        </div>
        <UpcomingInvoice a={a} />
      </div>

      <div className="grid g2 sec">
        <div className="card">
          <h3>Simulador de tráfico</h3>
          <p className="muted" style={{ fontSize: 14 }}>Genera peticiones falsas a la API y las envía a <code>/api/usage</code>, igual que haría tu backend con Metronome.</p>
          <label className="f" htmlFor="intensity">Intensidad: x{intensity}</label>
          <input id="intensity" type="range" min={1} max={20} value={intensity} onChange={e => setIntensity(+e.target.value)} />
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => tick()} disabled={running}>Enviar 1 petición</button>
            {running ? <button className="btn" onClick={stop}>Parar</button> : <button className="btn primary" onClick={start}>Tráfico continuo</button>}
          </div>
          {msg && <div className="banner bad" style={{ marginTop: 12 }}>{msg}</div>}
          <div className="label" style={{ marginTop: 18 }}>Coste de las últimas peticiones</div>
          <div className="chart">{recent.map(u => <i key={u.id} title={eur(u.cost)} style={{ height: `${(u.cost / max) * 100}%` }} />)}</div>
        </div>
        <div className="card">
          <h3>Alertas</h3>
          <p className="muted" style={{ fontSize: 13 }}>{a.mode === "metronome" ? "Llegan como webhooks de Metronome." : "Generadas en local; en producción llegan como webhooks de Metronome."}</p>
          {a.alerts.length === 0 && <p className="muted">Sin alertas.</p>}
          {a.alerts.slice(0, 8).map(al => (
            <div key={al.id} className={`alert ${al.type}`}>
              <span className="muted" style={{ fontSize: 12 }}>{new Date(al.ts).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}</span>
              {al.source === "webhook" && <span className={`badge ${al.verified ? "ok" : "warn"}`} style={{ marginLeft: 6 }}>{al.verified ? "webhook firmado" : "webhook sin firma"}</span>} · {al.message}
            </div>
          ))}
        </div>
      </div>

      <div className="grid g2 sec">
        <div className="card">
          <h3>Consumo por métrica (mes actual)</h3>
          <div className="tablewrap"><table><thead><tr><th>Métrica</th><th>Cantidad</th><th>Coste</th></tr></thead>
            <tbody>{totals.map(t => <tr key={t.m}><td>{METRICS[t.m].name}</td><td>{fmt(t.qty)}</td><td>{eur(t.cost)}</td></tr>)}</tbody></table></div>
        </div>
        <div className="card">
          <h3>Desglose del saldo</h3>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Se consume en este orden: créditos del plan → promociones → regalos → saldo pagado. Dentro de cada tipo, primero lo que caduca antes.</p>
          <div className="tablewrap"><table><thead><tr><th>Origen</th><th>Restante</th></tr></thead>
            <tbody>{a.credits.filter(c => c.remaining > 0 || c.kind === "recurring").map(c => <tr key={c.id}><td>{c.label} <span className={`badge ${KIND[c.kind].cls}`}>{KIND[c.kind].label}</span>{c.expiresAt && <div className="muted" style={{ fontSize: 12 }}>caduca el {new Date(c.expiresAt).toLocaleDateString("es-ES", { timeZone: "UTC" })}</div>}</td><td style={{ whiteSpace: "nowrap" }}>{eur(c.remaining)} / {eur(c.amount)}</td></tr>)}</tbody></table></div>
        </div>
      </div>
    </main>
  );
}

export default function Page() { return <Guard>{a => <Dashboard a={a} />}</Guard>; }
