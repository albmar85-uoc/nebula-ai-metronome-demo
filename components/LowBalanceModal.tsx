"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { BUNDLES, PLANS, eur, type BundleId } from "@/lib/catalog";
import { api, type AccountView } from "./useAccount";

const KEY = "nebula_modal_dismissed";

/** Modal que ofrece un bundle cuando llega una alerta de saldo bajo o saldo agotado. */
export default function LowBalanceModal({ a }: { a: AccountView }) {
  const trigger = a.alerts.find(al => al.type === "low_balance" || al.type === "zero_balance");
  const [dismissed, setDismissed] = useState<string | null>("?");
  const [busy, setBusy] = useState<BundleId | "">("");
  const [err, setErr] = useState("");
  useEffect(() => { setDismissed(localStorage.getItem(KEY)); }, []);
  // Solo alertas recientes (últimas 24 h) y con saldo todavía bajo.
  const fresh = trigger && Date.now() - +new Date(trigger.ts) < 24 * 3600 * 1000;
  const stillLow = a.blocked || a.balance < PLANS[a.plan].monthlyCredits * 0.2 + 0.0001;
  if (!trigger || !fresh || !stillLow || dismissed === "?" || dismissed === trigger.id) return null;
  const close = () => { localStorage.setItem(KEY, trigger.id); setDismissed(trigger.id); };
  async function buy(b: BundleId) {
    setBusy(b); setErr("");
    try { await api("/api/bundles/buy", { bundle: b, purchaseId: `pur_${crypto.randomUUID()}` }); close(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }
  const zero = trigger.type === "zero_balance";
  return (
    <div className="modal-bg" role="dialog" aria-modal="true" aria-labelledby="lbm-title" onClick={close}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3 id="lbm-title">{zero ? "Te has quedado sin saldo" : "Te queda poco saldo"}</h3>
        <p className="muted">{zero ? (PLANS[a.plan].overage ? "El uso extra se facturará a fin de mes. Si prefieres prepago con bonificación, recarga ahora." : "Las peticiones a la API están en pausa hasta que recargues.") : `Saldo actual: ${eur(a.balance)}. Recarga ahora y llévate saldo de regalo.`}</p>
        <div className="grid" style={{ gap: 10, margin: "14px 0" }}>
          {(Object.keys(BUNDLES) as BundleId[]).slice(0, 2).map(id => {
            const b = BUNDLES[id];
            return (
              <button key={id} className={`btn ${id === "b50" ? "primary" : ""}`} disabled={!!busy} onClick={() => buy(id)}>
                {busy === id ? "Cobrando…" : <>Pagar {eur(b.price)} → recibir {eur(b.credit)} <span className="badge ok">+{eur(b.credit - b.price)}</span></>}
              </button>
            );
          })}
        </div>
        {err && <div className="banner bad">{err}</div>}
        <div className="row"><Link href="/billing" className="muted sp" onClick={close}><u>Ver todas las opciones</u></Link><button className="btn small" onClick={close}>Ahora no</button></div>
      </div>
    </div>
  );
}
