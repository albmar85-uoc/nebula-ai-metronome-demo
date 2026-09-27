"use client";
import { useState } from "react";
import Guard from "@/components/Guard";
import Link from "next/link";
import Banners from "@/components/Banners";
import LowBalanceModal from "@/components/LowBalanceModal";
import { api, useConfig, type AccountView } from "@/components/useAccount";
import SpendThresholdNotice from "@/components/SpendThresholdNotice";
import SpendCapForm from "@/components/SpendCapForm";
import { AUTO_RECHARGE, BUNDLES, PLANS, PROMOTIONS, SPEND_THRESHOLD, eur, type BundleId, type PlanId } from "@/lib/catalog";
import type { Invoice } from "@/lib/billing/types";
import { UnbillableBadge } from "@/components/BillableBadge";

const STATUS: Record<Invoice["status"], { label: string; cls: string }> = {
  paid: { label: "paid", cls: "ok" }, pending: { label: "pending", cls: "warn" }, draft: { label: "draft", cls: "" }, void: { label: "void", cls: "bad" }, failed: { label: "payment failed", cls: "bad" },
};

function Billing({ a }: { a: AccountView }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [code, setCode] = useState("");
  const cfg = useConfig();
  const promos = cfg?.promotions ?? Object.entries(PROMOTIONS).map(([k, v]) => ({ code: k, label: v.label, amountEur: v.amount, validDays: v.validDays }));
  async function run(key: string, path: string, body: unknown, done?: string) {
    setBusy(key); setErr(""); setOk("");
    try { await api(path, body); if (done) setOk(done); return true; } catch (e) { setErr((e as Error).message); return false; } finally { setBusy(""); }
  }
  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "long", timeZone: "UTC" });
  const cur = PLANS[a.plan];
  const start = +new Date(a.periodStart), end = +new Date(a.periodEnd);
  const ratio = Math.max(0, (end - (a.now ? +new Date(a.now) : Date.now())) / (end - start));

  return (
    <main className="wrap">
      <h2>Billing</h2>
      <Banners a={a} />
      <LowBalanceModal a={a} />
      <div role="alert">{err && <div className="banner bad">{err}</div>}</div>
      <div role="status" aria-live="polite">{ok && <div className="banner info">{ok}</div>}</div>

      {a.plan === "scale" && <SpendThresholdNotice a={a} />}
      <h3>Your plan</h3>
      <div className="grid g3" data-tour="upgrade">
        {Object.values(PLANS).map(p => {
          const isCur = p.id === a.plan;
          const isPending = a.pendingPlan?.plan === p.id;
          const up = p.rank > cur.rank;
          return (
            <div key={p.id} className={`card ${isCur ? "hl" : ""}`}>
              <div className="row"><h3 className="sp">{p.name}</h3>{isCur && <span className="badge acc">Current</span>}{isCur && a.pendingPlan && <button className="btn small" disabled={!!busy} onClick={() => run("cancel", "/api/plan/change", { plan: p.id }, "Downgrade cancelled.")}>Cancel downgrade</button>}{isPending && <span className="badge warn">Scheduled</span>}</div>
              <div className="price">{eur(p.monthlyFee)} <small>/ month</small></div>
              <ul className="clean">{p.features.map(f => <li key={f}>{f}</li>)}</ul>
              {!isCur && !isPending && (
                <>
                  {up && <p className="muted" style={{ fontSize: 13 }}>Takes effect now: you'd pay {eur((p.monthlyFee - cur.monthlyFee) * ratio)} today (prorated) and get {eur(p.monthlyCredits * ratio)} in credits for the days left in the cycle. Your full current balance carries over.</p>}
                  {!up && <p className="muted" style={{ fontSize: 13 }}>Takes effect on {fmtDay(a.periodEnd)}, at the start of the next period. You keep bundles, gifts and promos.</p>}
                  <button className={`btn ${up ? "primary" : ""}`} style={{ width: "100%" }} disabled={!!busy} onClick={() => run(p.id, "/api/plan/change", { plan: p.id as PlanId })}>{busy === p.id ? "Applying…" : up ? `Upgrade to ${p.name}` : `Downgrade to ${p.name}`}</button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="sec"><SpendCapForm a={a} /></div>

      <div className="grid g2 sec">
        <div className="card" data-tour="bundle">
          <h3>Buy balance</h3>
          <p className="muted" style={{ fontSize: 14 }}>Charged right away to your saved card. The balance is released once Stripe confirms the payment and the gift is added right after. Valid for 12 months.</p>
          {Object.values(BUNDLES).map(b => (
            <div key={b.id} className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
              <div className="sp"><b>{eur(b.credit)}</b> balance <span className="badge ok">+{eur(b.credit - b.price)} gift</span></div>
              <button className="btn small primary" aria-label={`Pay ${eur(b.price)} and get ${eur(b.credit)} balance`} disabled={!!busy} onClick={() => run(b.id, "/api/bundles/buy", { bundle: b.id as BundleId, purchaseId: `pur_${crypto.randomUUID()}` })}>{busy === b.id ? "Charging…" : `Pay ${eur(b.price)}`}</button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 16 }}>
            <div className="sp"><b>Auto-recharge</b> {a.autoRecharge && <span className="badge ok">on</span>}<div className="muted" style={{ fontSize: 13 }}>We top your balance up to {eur(AUTO_RECHARGE.rechargeTo)} whenever it drops below {eur(AUTO_RECHARGE.threshold)}, charging only the difference (no gift). <span data-testid="ar-terms">Each top-up is valid for {AUTO_RECHARGE.validityMonths} months and carries over in full when you change plans.</span>{a.autoRecharge && a.thresholdPending && a.thresholdPending.kind !== "spend_threshold" && <> <b data-testid="ar-pending">Switches on with your new plan at {new Date(a.thresholdPending.effectiveAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC.</b></>}{!cur.autoRechargeAllowed && " Available on Pro and Scale."}</div></div>
            <button className="btn small" aria-label={a.autoRecharge ? "Turn off auto-recharge" : "Turn on auto-recharge"} disabled={!cur.autoRechargeAllowed || !!busy} onClick={() => run("ar", "/api/autorecharge", { enabled: !a.autoRecharge })}>{a.autoRecharge ? "Turn off" : "Turn on"}</button>
          </div>
          {a.plan === "scale" && (
            <div className="row" style={{ marginTop: 16 }}>
              <div className="sp"><b>Early threshold charge</b> {a.spendThreshold?.enabled && <span className="badge ok">on</span>}<div className="muted" style={{ fontSize: 13 }}>If your overage this month reaches {eur(a.spendThreshold?.thresholdEur ?? SPEND_THRESHOLD.scaleThreshold)}, we charge it right away (avoids a big month-end invoice). <span data-testid="st-always">Always on for Scale, together with auto-recharge if you use it.</span>{a.thresholdPending && a.thresholdPending.kind !== "auto_recharge" && <> <b>Switches on with your new plan at {new Date(a.thresholdPending.effectiveAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC.</b></>}</div></div>
              {a.spendThreshold?.enabled
                ? <span className="badge" data-testid="st-always-badge">Always on</span>
                : /* e.g. Metronome disables it after a failed payment: re-enabling forces a new evaluation */
                  <button className="btn small" aria-label="Turn on early threshold charge" disabled={!!busy} onClick={() => run("st", "/api/spend-threshold", { enabled: true })}>Turn on</button>}
            </div>
          )}
          <form className="sec" data-tour="promo" onSubmit={async e => { e.preventDefault(); if (await run("promo", "/api/promo", { code }, `Code ${code.trim().toUpperCase()} redeemed.`)) setCode(""); }}>
            <label className="f" htmlFor="promo"><b>Promo code</b></label>
            <div className="promo">
              <input id="promo" aria-describedby="promo-help" placeholder="e.g. WELCOME10" value={code} onChange={e => setCode(e.target.value)} autoComplete="off" />
              <button className="btn small primary" disabled={!code.trim() || !!busy}>{busy === "promo" ? "Redeeming…" : "Redeem"}</button>
            </div>
            <p id="promo-help" className="muted" style={{ fontSize: 12 }}>Free credit with an expiry date; used before paid balance. Demo codes: {promos.map(p => `${p.code} (${eur(p.amountEur)}, ${p.validDays} days)`).join(" · ")}.</p>
          </form>
        </div>
        <div className="card">
          <h3>Invoices and charges</h3>
          <div className="tablewrap" tabIndex={0}><table><caption className="sr-only">Invoices and charges; open one to see the details</caption><thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col" style={{ textAlign: "right" }}>Amount</th></tr></thead>
            <tbody>{a.invoices.length === 0 ? <tr><td colSpan={3} className="muted">No charges yet.</td></tr> : a.invoices.map(i => (
              <tr key={i.id} className="clickable">
                <td><Link tabIndex={-1} aria-hidden="true" href={`/billing/invoices/${encodeURIComponent(i.id)}`}>{new Date(i.date).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</Link></td>
                <td><Link href={`/billing/invoices/${encodeURIComponent(i.id)}`}>{i.description}</Link></td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{eur(i.amount)} {(i.billableStatus !== "unbillable" || i.status === "draft") && <span className={`badge ${STATUS[i.status].cls}`}>{STATUS[i.status].label}</span>} <UnbillableBadge invoice={i} /></td>
              </tr>))}</tbody></table></div>
          <p className="muted" style={{ fontSize: 13 }}>Select an invoice to see the details.</p>
        </div>
      </div>
    </main>
  );
}

export default function Page() { return <Guard>{a => <Billing a={a} />}</Guard>; }
