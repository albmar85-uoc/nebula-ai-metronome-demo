"use client";
import { useState } from "react";
import Guard from "@/components/Guard";
import Link from "next/link";
import Banners from "@/components/Banners";
import LowBalanceModal from "@/components/LowBalanceModal";
import { api, type AccountView } from "@/components/useAccount";
import { AUTO_RECHARGE, BUNDLES, PLANS, eur, type BundleId, type PlanId } from "@/lib/catalog";
import type { Invoice } from "@/lib/billing/types";

const STATUS: Record<Invoice["status"], { label: string; cls: string }> = {
  paid: { label: "pagada", cls: "ok" }, pending: { label: "pendiente", cls: "warn" }, draft: { label: "borrador", cls: "" }, void: { label: "anulada", cls: "bad" },
};

function Billing({ a }: { a: AccountView }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  async function run(key: string, path: string, body: unknown) {
    setBusy(key); setErr("");
    try { await api(path, body); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }
  const cur = PLANS[a.plan];
  const start = +new Date(a.periodStart), end = +new Date(a.periodEnd);
  const ratio = Math.max(0, (end - Date.now()) / (end - start));

  return (
    <main className="wrap">
      <h2>Facturación</h2>
      <Banners a={a} />
      <LowBalanceModal a={a} />
      {err && <div className="banner bad">{err}</div>}

      <h3>Tu plan</h3>
      <div className="grid g3">
        {Object.values(PLANS).map(p => {
          const isCur = p.id === a.plan;
          const isPending = a.pendingPlan?.plan === p.id;
          const up = p.monthlyFee > cur.monthlyFee;
          return (
            <div key={p.id} className={`card ${isCur ? "hl" : ""}`}>
              <div className="row"><h3 className="sp">{p.name}</h3>{isCur && <span className="badge acc">Actual</span>}{isPending && <span className="badge warn">Programado</span>}</div>
              <div className="price">{eur(p.monthlyFee)} <small>/ mes</small></div>
              <ul className="clean">{p.features.map(f => <li key={f}>{f}</li>)}</ul>
              {!isCur && !isPending && (
                <>
                  {up && <p className="muted" style={{ fontSize: 13 }}>Hoy pagarías {eur((p.monthlyFee - cur.monthlyFee) * ratio)} (prorrateo) y recibirías {eur((p.monthlyCredits - cur.monthlyCredits) * ratio)} en créditos.</p>}
                  {!up && <p className="muted" style={{ fontSize: 13 }}>El nuevo precio se aplica en el próximo ciclo.</p>}
                  <button className={`btn ${up ? "primary" : ""}`} style={{ width: "100%" }} disabled={!!busy} onClick={() => run(p.id, "/api/plan/change", { plan: p.id as PlanId })}>{busy === p.id ? "Aplicando…" : up ? `Subir a ${p.name}` : `Bajar a ${p.name}`}</button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="grid g2 sec">
        <div className="card">
          <h3>Comprar saldo</h3>
          <p className="muted" style={{ fontSize: 14 }}>Se cobra al momento en tu tarjeta guardada. El saldo se libera cuando Stripe confirma el pago.</p>
          {Object.values(BUNDLES).map(b => (
            <div key={b.id} className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
              <div className="sp"><b>{eur(b.credit)}</b> de saldo <span className="badge ok">+{eur(b.credit - b.price)} de regalo</span></div>
              <button className="btn small primary" disabled={!!busy} onClick={() => run(b.id, "/api/bundles/buy", { bundle: b.id as BundleId })}>{busy === b.id ? "Cobrando…" : `Pagar ${eur(b.price)}`}</button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 16 }}>
            <div className="sp"><b>Recarga automática</b><div className="muted" style={{ fontSize: 13 }}>Cuando el saldo baje de {eur(AUTO_RECHARGE.threshold)}, recargamos el bundle de {eur(BUNDLES[AUTO_RECHARGE.bundle].price)}.{!cur.autoRechargeAllowed && " Disponible en Pro y Scale."}</div></div>
            <button className="btn small" disabled={!cur.autoRechargeAllowed || !!busy} onClick={() => run("ar", "/api/autorecharge", { enabled: !a.autoRecharge })}>{a.autoRecharge ? "Desactivar" : "Activar"}</button>
          </div>
        </div>
        <div className="card">
          <h3>Facturas y cobros</h3>
          <div className="tablewrap"><table><thead><tr><th>Fecha</th><th>Concepto</th><th style={{ textAlign: "right" }}>Importe</th></tr></thead>
            <tbody>{a.invoices.length === 0 ? <tr><td colSpan={3} className="muted">Todavía no hay cobros.</td></tr> : a.invoices.map(i => (
              <tr key={i.id} className="clickable">
                <td><Link href={`/billing/invoices/${encodeURIComponent(i.id)}`}>{new Date(i.date).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}</Link></td>
                <td><Link href={`/billing/invoices/${encodeURIComponent(i.id)}`}>{i.description}</Link></td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{eur(i.amount)} <span className={`badge ${STATUS[i.status].cls}`}>{STATUS[i.status].label}</span></td>
              </tr>))}</tbody></table></div>
          <p className="muted" style={{ fontSize: 13 }}>Pulsa una factura para ver el detalle.</p>
        </div>
      </div>
    </main>
  );
}

export default function Page() { return <Guard>{a => <Billing a={a} />}</Guard>; }
