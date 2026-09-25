"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AdminGate from "@/components/AdminGate";
import { METRICS, PLANS, eur, type PlanId } from "@/lib/catalog";
import type { AccountView } from "@/components/useAccount";
import type { AdminLogEntry, PlanEvent, Purchase } from "@/lib/store";
import type { PublicApiKey } from "@/lib/apikeys";
import { isArchivableDemoCustomer } from "@/lib/billing/types";

type Detail = { account: AccountView; planHistory: PlanEvent[]; adminLog: AdminLogEntry[]; apiKeys: PublicApiKey[]; purchases: Purchase[]; link?: { metronomeCustomerId: string; metronomeContractId: string; stripeCustomerId?: string } };
const dt = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });
const d = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC" });
const KIND: Record<PlanEvent["kind"], string> = { signup: "Sign-up", upgrade: "Upgrade (immediate)", downgrade_scheduled: "Downgrade scheduled", downgrade_applied: "Downgrade applied", downgrade_cancelled: "Downgrade cancelled" };
const ACTOR: Record<string, string> = { customer: "customer", support: "support", system: "system" };
const ACTION: Record<string, string> = { goodwill_credit: "Goodwill credit", unblock: "Unblock", plan_change: "Plan change" };
const CREDIT: Record<string, string> = { recurring: "plan credit", promo: "promo", gift: "gift", commit: "paid balance" };

function CustomerDetail({ logout }: { logout: () => void }) {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState("");
  const [amount, setAmount] = useState("5");
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState<PlanId>("pro");
  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/customers/${encodeURIComponent(id)}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { setErr(j.error); return; }
    setData(j);
  }, [id]);
  useEffect(() => { load(); }, [load]);
  async function act(key: string, path: string, body: unknown, done: string) {
    setBusy(key); setErr(""); setOk("");
    try {
      const r = await fetch(`/api/admin/customers/${encodeURIComponent(id)}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setOk(done); await load(); return true;
    } catch (e) { setErr((e as Error).message); return false; } finally { setBusy(""); }
  }
  async function archive() {
    if (!window.confirm(`Archive "${data?.account.name}"? This frees a demo slot and removes the customer from this app.`)) return;
    setBusy("archive"); setErr(""); setOk("");
    try {
      const r = await fetch(`/api/admin/customers/${encodeURIComponent(id)}/archive`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      window.location.href = "/admin";
    } catch (e) { setErr((e as Error).message); setBusy(""); }
  }
  if (!data) return <main className="wrap">{err ? <div className="banner bad" role="alert">{err}</div> : <p className="muted">Loading…</p>}</main>;
  const a = data.account;
  const p = PLANS[a.plan];
  return (
    <main className="wrap">
      <p style={{ margin: "0 0 8px" }}><Link href="/admin" className="muted">← Customers</Link></p>
      <div className="row"><h2 className="sp" style={{ marginBottom: 0 }}>{a.name}</h2>
        {a.blocked ? <span className="badge bad">blocked</span> : a.capReached ? <span className="badge warn">limit reached</span> : <span className="badge ok">active</span>}
        <button className="btn small" onClick={logout}>Sign out of support</button></div>
      <p className="muted" style={{ marginTop: 4 }}>{a.email} · <code>{a.customerId}</code>{data.link && <> · Metronome <code>{data.link.metronomeCustomerId}</code> · contract <code>{data.link.metronomeContractId}</code></>}</p>
      <div role="alert">{err && <div className="banner bad">{err}</div>}</div>
      <div role="status" aria-live="polite">{ok && <div className="banner info">{ok}</div>}</div>

      <div className="grid g4">
        <div className="card"><div className="label">Plan</div><div className="stat">{p.name}</div><div className="muted" style={{ fontSize: 13 }}>{a.pendingPlan ? `→ ${PLANS[a.pendingPlan.plan].name} on ${d(a.pendingPlan.effectiveAt)}` : `Period ${d(a.periodStart)} – ${d(a.periodEnd)}`}</div></div>
        <div className="card"><div className="label">Balance</div><div className="stat">{eur(a.balance)}</div><div className="muted" style={{ fontSize: 13 }}>{a.accessCut ? "Access cut off by webhook" : a.blocked ? "No balance" : "Available"}</div></div>
        <div className="card"><div className="label">Spend this period</div><div className="stat">{eur(a.spent)}</div><div className="muted" style={{ fontSize: 13 }}>{a.spendCap ? `Limit ${eur(a.spendCap.monthlyEur)}` : "No limit"}</div></div>
        <div className="card"><div className="label">Next invoice</div><div className="stat">{eur(a.upcoming?.totalDueEur ?? 0)}</div><div className="muted" style={{ fontSize: 13 }}>{a.upcoming?.periodEnd ? `on ${d(a.upcoming.periodEnd)}` : "—"}</div></div>
      </div>

      <section className="card sec" aria-labelledby="actions-title">
        <h3 id="actions-title">Support actions</h3>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Every action is logged and the customer sees it in their alerts.</p>
        <div className="grid g3">
          <form onSubmit={async e => { e.preventDefault(); if (await act("gw", "goodwill", { amountEur: Number(amount.replace(",", "")), reason, grantId: `gw_${crypto.randomUUID()}` }, `Goodwill credit of ${eur(Number(amount.replace(",", "")))} granted.`)) setReason(""); }}>
            <h4 style={{ margin: "0 0 4px" }}>Goodwill credit</h4>
            <div className="formrow">
              <div style={{ maxWidth: 110, minWidth: 90 }}><label className="f" htmlFor="gw-amount">Amount (€)</label><input id="gw-amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required /></div>
              <div><label className="f" htmlFor="gw-reason">Reason</label><input id="gw-reason" value={reason} maxLength={140} onChange={e => setReason(e.target.value)} placeholder="e.g. outage on 9/24" required /></div>
            </div>
            <button className="btn primary" style={{ width: "100%", marginTop: 10 }} disabled={!!busy}>{busy === "gw" ? "Granting…" : "Grant credit"}</button>
            <p className="muted" style={{ fontSize: 12 }}>Expires after 90 days. Used before paid balance.</p>
          </form>
          <div>
            <h4 style={{ margin: "0 0 4px" }}>Unblock</h4>
            <p className="muted" style={{ fontSize: 13 }}>Lifts the access block (zero-balance webhook or failed payment). If there is no balance, also grant a credit.</p>
            <button className="btn" style={{ width: "100%" }} disabled={!!busy || (!a.blocked && !a.accessCut)} onClick={() => act("unblock", "unblock", {}, "Access re-enabled.")}>{busy === "unblock" ? "Unblocking…" : "Unblock access"}</button>
          </div>
          {isArchivableDemoCustomer(a.name) && (
            <div>
              <h4 style={{ margin: "0 0 4px" }}>Archive demo customer</h4>
              <p className="muted" style={{ fontSize: 13 }}>Frees a slot: the Metronome sandbox allows 5 active customers. Only for customers named &ldquo;Nebula demo …&rdquo;.</p>
              <button className="btn" style={{ width: "100%" }} disabled={!!busy} onClick={archive}>{busy === "archive" ? "Archiving…" : "Archive customer"}</button>
            </div>
          )}
          <form onSubmit={e => { e.preventDefault(); act("plan", "plan", { plan }, `Plan updated (${PLANS[plan].name}).`); }}>
            <h4 style={{ margin: "0 0 4px" }}>Change plan</h4>
            <label className="f" htmlFor="adm-plan">New plan</label>
            <select id="adm-plan" value={plan} onChange={e => setPlan(e.target.value as PlanId)}>{Object.values(PLANS).map(x => <option key={x.id} value={x.id}>{x.name}{x.id === a.plan ? " (current)" : ""}</option>)}</select>
            <button className="btn" style={{ width: "100%", marginTop: 10 }} disabled={!!busy}>{busy === "plan" ? "Applying…" : "Apply change"}</button>
            <p className="muted" style={{ fontSize: 12 }}>Upgrades are immediate and prorated; downgrades apply next period. Choosing the current plan cancels a scheduled downgrade.</p>
          </form>
        </div>
      </section>

      <div className="grid g2 sec">
        <section className="card" aria-labelledby="credits-title">
          <h3 id="credits-title">Credits and commits</h3>
          <div className="tablewrap" tabIndex={0}><table><caption className="sr-only">Credits and commits</caption>
            <thead><tr><th scope="col">Source</th><th scope="col">Type</th><th scope="col" style={{ textAlign: "right" }}>Remaining</th><th scope="col">Expires</th></tr></thead>
            <tbody>{a.credits.map(c => <tr key={c.id}><td>{c.label}{c.reference && <div className="muted" style={{ fontSize: 12 }}>{c.reference}</div>}</td><td><span className="badge">{c.reference?.startsWith("goodwill:") ? "goodwill" : CREDIT[c.kind]}</span></td><td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{eur(c.remaining)} / {eur(c.amount)}</td><td>{c.expiresAt ? d(c.expiresAt) : "—"}</td></tr>)}</tbody>
          </table></div>
        </section>
        <section className="card" aria-labelledby="hist-title">
          <h3 id="hist-title">Plan and contract history</h3>
          <div className="tablewrap" tabIndex={0}><table><caption className="sr-only">Plan history</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Change</th><th scope="col">By</th></tr></thead>
            <tbody>{data.planHistory.length === 0 ? <tr><td colSpan={3} className="muted">No changes recorded.</td></tr> : data.planHistory.map((h, i) => (
              <tr key={i}><td>{dt(h.ts)}</td><td>{KIND[h.kind]}: {h.from ? `${PLANS[h.from].name} → ` : ""}{PLANS[h.to].name}{h.effectiveAt && h.kind === "downgrade_scheduled" && <div className="muted" style={{ fontSize: 12 }}>effective {d(h.effectiveAt)}</div>}{h.contractId && <div className="muted" style={{ fontSize: 12 }}>contract {h.contractId}</div>}</td><td>{ACTOR[h.actor]}</td></tr>))}</tbody>
          </table></div>
        </section>
      </div>

      <div className="grid g2 sec">
        <section className="card" aria-labelledby="inv-title">
          <h3 id="inv-title">Invoices</h3>
          <div className="tablewrap" tabIndex={0}><table><caption className="sr-only">Invoices</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col" style={{ textAlign: "right" }}>Amount</th></tr></thead>
            <tbody>{a.invoices.slice(0, 12).map(i => <tr key={i.id}><td>{dt(i.date)}</td><td>{i.description}</td><td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{eur(i.amount)} <span className="badge">{i.status}</span>{i.paymentError && <div className="muted" style={{ fontSize: 12 }}>{i.paymentError}</div>}</td></tr>)}</tbody>
          </table></div>
        </section>
        <section className="card" aria-labelledby="al-title">
          <h3 id="al-title">Alerts</h3>
          {a.alerts.slice(0, 10).map(al => <div key={al.id} className={`alert ${al.type}`}><span className="muted" style={{ fontSize: 12 }}>{dt(al.ts)}</span> · {al.message}</div>)}
          {a.alerts.length === 0 && <p className="muted">No alerts.</p>}
        </section>
      </div>

      <div className="grid g2 sec">
        <section className="card" aria-labelledby="use-title">
          <h3 id="use-title">Recent usage</h3>
          <div className="tablewrap" tabIndex={0}><table><caption className="sr-only">Latest usage events</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Request</th><th scope="col">Metric</th><th scope="col" style={{ textAlign: "right" }}>Cost</th></tr></thead>
            <tbody>{a.usage.length === 0 ? <tr><td colSpan={4} className="muted">No usage.</td></tr> : a.usage.slice(0, 12).map(u => <tr key={u.id}><td>{dt(u.ts)}</td><td><code style={{ fontSize: 11 }}>{(u.requestId ?? u.id).slice(0, 22)}</code></td><td>{new Intl.NumberFormat("en-US").format(u.quantity)} {METRICS[u.metric].unit}</td><td style={{ textAlign: "right" }}>{eur(u.cost)}</td></tr>)}</tbody>
          </table></div>
        </section>
        <section className="card" aria-labelledby="log-title">
          <h3 id="log-title">Support log and keys</h3>
          {data.adminLog.length === 0 && <p className="muted">No support actions.</p>}
          {data.adminLog.map(l => <div key={l.id} className="alert support"><span className="muted" style={{ fontSize: 12 }}>{dt(l.ts)}</span> · <b>{ACTION[l.action] ?? l.action}</b>: {l.detail}</div>)}
          <p className="muted" style={{ fontSize: 13 }}>API keys: {data.apiKeys.length === 0 ? "none" : data.apiKeys.map(k => `${k.name} (${k.prefix}…${k.revokedAt ? ", revoked" : ""})`).join(" · ")}</p>
          {data.purchases.length > 0 && <p className="muted" style={{ fontSize: 13 }}>Bundle purchases: {data.purchases.map(x => `${x.bundle} ${x.status === "bonus_granted" ? "paid + gift" : x.status === "failed" ? "failed" : "payment pending"}`).join(" · ")}</p>}
        </section>
      </div>
    </main>
  );
}

export default function Page() { return <AdminGate>{logout => <CustomerDetail logout={logout} />}</AdminGate>; }
