"use client";
import { useState } from "react";
import { eur } from "@/lib/catalog";
import { CAP_ALERT_RATIO, CAP_MIN_EUR } from "@/lib/billing/limits";
import { api, type AccountView } from "./useAccount";

/** Límite de gasto mensual del cliente: aviso al 80 % y rechazo (402) de las peticiones que lo superarían. */
export default function SpendCapForm({ a }: { a: AccountView }) {
  const [value, setValue] = useState(a.spendCap ? String(a.spendCap.monthlyEur) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save(monthlyEur: number | null) {
    setBusy(true); setMsg(null);
    try {
      await api("/api/spend-cap", { monthlyEur });
      setMsg({ ok: true, text: monthlyEur === null ? "Limit removed." : `Limit saved: ${eur(monthlyEur)} per month.` });
      if (monthlyEur === null) setValue("");
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  const pct = a.spendCap ? Math.min(100, (a.spent / a.spendCap.monthlyEur) * 100) : 0;
  return (
    <section className="card" id="limit" aria-labelledby="cap-title">
      <h3 id="cap-title">Monthly spend limit</h3>
      <p className="muted" style={{ fontSize: 14 }}>We alert you at {CAP_ALERT_RATIO * 100}% and, once you reach it, the API rejects requests with <code>402</code> until the next period. It counts all usage this month (with your discount), whether credits cover it or not.</p>
      {a.spendCap && (
        <>
          <div className="bar" role="progressbar" aria-label="Spend this month against the limit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-valuetext={`${eur(a.spent)} of ${eur(a.spendCap.monthlyEur)}`}><i style={{ width: `${pct}%`, background: a.capReached ? "var(--bad)" : undefined }} /></div>
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>Spent {eur(a.spent)} of {eur(a.spendCap.monthlyEur)}{a.capReached ? " · limit reached" : ""}.</p>
        </>
      )}
      <form className="formrow" onSubmit={e => { e.preventDefault(); save(Number(value.replace(",", ""))); }}>
        <div>
          <label className="f" htmlFor="cap">Limit (€ per month)</label>
          <input id="cap" inputMode="decimal" placeholder="e.g. 100" value={value} onChange={e => setValue(e.target.value)} aria-describedby="cap-help" />
        </div>
        <button className="btn primary" disabled={busy || !value.trim()}>{busy ? "Saving…" : a.spendCap ? "Update" : "Set limit"}</button>
        {a.spendCap && <button type="button" className="btn" disabled={busy} onClick={() => save(null)}>Remove limit</button>}
      </form>
      <p id="cap-help" className="muted" style={{ fontSize: 12 }}>Minimum {eur(CAP_MIN_EUR)}. This is not a Metronome limit: nebula.ai enforces it before accepting each request.</p>
      <div role="status" aria-live="polite">{msg && <div className={`banner ${msg.ok ? "info" : "bad"}`} style={{ marginBottom: 0 }}>{msg.text}</div>}</div>
    </section>
  );
}
