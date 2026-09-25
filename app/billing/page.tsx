"use client";
import { useState } from "react";
import Guard from "@/components/Guard";
import Link from "next/link";
import Banners from "@/components/Banners";
import LowBalanceModal from "@/components/LowBalanceModal";
import { api, type AccountView } from "@/components/useAccount";
import SpendThresholdNotice from "@/components/SpendThresholdNotice";
import { AUTO_RECHARGE, BUNDLES, PLANS, PROMOTIONS, SPEND_THRESHOLD, eur, type BundleId, type PlanId } from "@/lib/catalog";
import type { Invoice } from "@/lib/billing/types";

const STATUS: Record<Invoice["status"], { label: string; cls: string }> = {
  paid: { label: "pagada", cls: "ok" }, pending: { label: "pendiente", cls: "warn" }, draft: { label: "borrador", cls: "" }, void: { label: "anulada", cls: "bad" },
};

function Billing({ a }: { a: AccountView }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [code, setCode] = useState("");
  async function run(key: string, path: string, body: unknown, done?: string) {
    setBusy(key); setErr(""); setOk("");
    try { await api(path, body); if (done) setOk(done); return true; } catch (e) { setErr((e as Error).message); return false; } finally { setBusy(""); }
  }
  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "long", timeZone: "UTC" });
  const cur = PLANS[a.plan];
  const start = +new Date(a.periodStart), end = +new Date(a.periodEnd);
  const ratio = Math.max(0, (end - Date.now()) / (end - start));

  return (
    <main className="wrap">
      <h2>Facturación</h2>
      <Banners a={a} />
      <LowBalanceModal a={a} />
      {err && <div className="banner bad">{err}</div>}
      {ok && <div className="banner info">{ok}</div>}

      {a.plan === "scale" && <SpendThresholdNotice a={a} />}
      <h3>Tu plan</h3>
      <div className="grid g3">
        {Object.values(PLANS).map(p => {
          const isCur = p.id === a.plan;
          const isPending = a.pendingPlan?.plan === p.id;
          const up = p.rank > cur.rank;
          return (
            <div key={p.id} className={`card ${isCur ? "hl" : ""}`}>
              <div className="row"><h3 className="sp">{p.name}</h3>{isCur && <span className="badge acc">Actual</span>}{isCur && a.pendingPlan && <button className="btn small" disabled={!!busy} onClick={() => run("cancel", "/api/plan/change", { plan: p.id }, "Bajada cancelada.")}>Cancelar bajada</button>}{isPending && <span className="badge warn">Programado</span>}</div>
              <div className="price">{eur(p.monthlyFee)} <small>/ mes</small></div>
              <ul className="clean">{p.features.map(f => <li key={f}>{f}</li>)}</ul>
              {!isCur && !isPending && (
                <>
                  {up && <p className="muted" style={{ fontSize: 13 }}>Cambio inmediato: hoy pagarías {eur((p.monthlyFee - cur.monthlyFee) * ratio)} (prorrateo) y recibirías {eur(p.monthlyCredits * ratio)} en créditos. Conservas todo tu saldo actual.</p>}
                  {!up && <p className="muted" style={{ fontSize: 13 }}>Se aplica el {fmtDay(a.periodEnd)}, al empezar el siguiente periodo. Conservas bundles, regalos y promociones.</p>}
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
          <p className="muted" style={{ fontSize: 14 }}>Se cobra al momento en tu tarjeta guardada. El saldo se libera cuando Stripe confirma el pago y el regalo se añade justo después. Válido 12 meses.</p>
          {Object.values(BUNDLES).map(b => (
            <div key={b.id} className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
              <div className="sp"><b>{eur(b.credit)}</b> de saldo <span className="badge ok">+{eur(b.credit - b.price)} de regalo</span></div>
              <button className="btn small primary" disabled={!!busy} onClick={() => run(b.id, "/api/bundles/buy", { bundle: b.id as BundleId, purchaseId: `pur_${crypto.randomUUID()}` })}>{busy === b.id ? "Cobrando…" : `Pagar ${eur(b.price)}`}</button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 16 }}>
            <div className="sp"><b>Recarga automática</b> {a.autoRecharge && <span className="badge ok">activa</span>}<div className="muted" style={{ fontSize: 13 }}>Cuando el saldo baje de {eur(AUTO_RECHARGE.threshold)}, cobramos lo necesario para dejarlo en {eur(AUTO_RECHARGE.rechargeTo)}.{!cur.autoRechargeAllowed && " Disponible en Pro y Scale."}{a.spendThreshold?.enabled && " No se puede combinar con el cobro anticipado por umbral."}</div></div>
            <button className="btn small" disabled={!cur.autoRechargeAllowed || !!busy || (!a.autoRecharge && !!a.spendThreshold?.enabled)} onClick={() => run("ar", "/api/autorecharge", { enabled: !a.autoRecharge })}>{a.autoRecharge ? "Desactivar" : "Activar"}</button>
          </div>
          {a.plan === "scale" && (
            <div className="row" style={{ marginTop: 16 }}>
              <div className="sp"><b>Cobro anticipado por umbral</b> {a.spendThreshold?.enabled && <span className="badge ok">activo</span>}<div className="muted" style={{ fontSize: 13 }}>Si tu uso extra del mes llega a {eur(a.spendThreshold?.thresholdEur ?? SPEND_THRESHOLD.scaleThreshold)}, lo cobramos al momento (evita una factura grande a fin de mes).</div></div>
              <button className="btn small" disabled={!!busy || (!a.spendThreshold?.enabled && a.autoRecharge)} onClick={() => run("st", "/api/spend-threshold", { enabled: !a.spendThreshold?.enabled })}>{a.spendThreshold?.enabled ? "Desactivar" : "Activar"}</button>
            </div>
          )}
          <form className="sec" onSubmit={async e => { e.preventDefault(); if (await run("promo", "/api/promo", { code }, `Código ${code.trim().toUpperCase()} canjeado.`)) setCode(""); }}>
            <label className="f" htmlFor="promo"><b>Código promocional</b></label>
            <div className="promo">
              <input id="promo" placeholder="p. ej. BIENVENIDA10" value={code} onChange={e => setCode(e.target.value)} autoComplete="off" />
              <button className="btn small primary" disabled={!code.trim() || !!busy}>{busy === "promo" ? "Canjeando…" : "Canjear"}</button>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>Crédito gratuito con caducidad; se gasta antes que el saldo pagado. Códigos de la demo: {Object.entries(PROMOTIONS).map(([k, v]) => `${k} (${eur(v.amount)}, ${v.validDays} días)`).join(" · ")}.</p>
          </form>
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
