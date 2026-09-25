"use client";
import { useEffect, useRef, useState } from "react";
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
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setDismissed(localStorage.getItem(KEY)); }, []);
  // Solo alertas recientes (últimas 24 h) y con saldo todavía bajo.
  const fresh = trigger && Date.now() - +new Date(trigger.ts) < 24 * 3600 * 1000;
  const stillLow = a.blocked || a.balance < PLANS[a.plan].monthlyCredits * 0.2 + 0.0001;
  const open = !!trigger && !!fresh && stillLow && dismissed !== "?" && dismissed !== trigger?.id;
  // Accesibilidad: foco al abrir, Escape cierra, Tab no sale del diálogo y el foco vuelve a donde estaba.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("button")?.focus();
    return () => prev?.focus?.();
  }, [open]);
  if (!open || !trigger) return null;
  const close = () => { localStorage.setItem(KEY, trigger.id); setDismissed(trigger.id); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab" || !box.current) return;
    const f = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  async function buy(b: BundleId) {
    setBusy(b); setErr("");
    try { await api("/api/bundles/buy", { bundle: b, purchaseId: `pur_${crypto.randomUUID()}` }); close(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }
  const zero = trigger.type === "zero_balance";
  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" ref={box} role="dialog" aria-modal="true" aria-labelledby="lbm-title" aria-describedby="lbm-desc" onKeyDown={onKey} onClick={e => e.stopPropagation()}>
        <h3 id="lbm-title">{zero ? "You're out of balance" : "Your balance is running low"}</h3>
        <p className="muted" id="lbm-desc">{zero ? (PLANS[a.plan].overage ? "Overage will be billed at month end. If you prefer prepaid with bonus credit, top up now." : "API requests are paused until you top up.") : `Current balance: ${eur(a.balance)}. Top up now and get bonus credit.`}</p>
        <div className="grid" style={{ gap: 10, margin: "14px 0" }}>
          {(Object.keys(BUNDLES) as BundleId[]).slice(0, 2).map(id => {
            const b = BUNDLES[id];
            return (
              <button key={id} className={`btn ${id === "b50" ? "primary" : ""}`} disabled={!!busy} onClick={() => buy(id)}>
                {busy === id ? "Charging…" : <>Pay {eur(b.price)} → get {eur(b.credit)} <span className="badge ok">+{eur(b.credit - b.price)}</span></>}
              </button>
            );
          })}
        </div>
        {err && <div className="banner bad" role="alert">{err}</div>}
        <div className="row"><Link href="/billing" className="muted sp" onClick={close}><u>See all options</u></Link><button className="btn small" onClick={close}>Not now</button></div>
      </div>
    </div>
  );
}
