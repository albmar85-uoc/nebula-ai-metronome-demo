"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AdminGate from "@/components/AdminGate";
import { PLANS, eur, type PlanId } from "@/lib/catalog";

type Row = { id: string; name: string; email: string; plan: PlanId; pendingPlan?: { plan: PlanId }; balance: number; spent: number; blocked: boolean; accessCut: boolean; capReached: boolean; spendCap?: number };

function Status({ r }: { r: Row }) {
  if (r.blocked) return <span className="badge bad">{r.accessCut ? "blocked (cut off)" : "blocked (no balance)"}</span>;
  if (r.capReached) return <span className="badge warn">limit reached</span>;
  return <span className="badge ok">active</span>;
}

function List({ logout }: { logout: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [mode, setMode] = useState("");
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(async (query = "") => {
    const r = await fetch(`/api/admin/customers?q=${encodeURIComponent(query)}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { setErr(j.error); return; }
    setRows(j.customers); setMode(j.mode);
  }, []);
  useEffect(() => { load(); }, [load]);
  const blocked = rows?.filter(r => r.blocked).length ?? 0;
  return (
    <main className="wrap">
      <div className="row"><h2 className="sp">Support panel</h2><span className="badge">{mode === "metronome" ? "live Metronome" : "simulated mode"}</span><button className="btn small" onClick={logout}>Sign out of support</button></div>
      <div role="alert">{err && <div className="banner bad">{err}</div>}</div>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="card"><div className="label">Customers</div><div className="stat">{rows?.length ?? "…"}</div></div>
        <div className="card"><div className="label">Blocked</div><div className="stat">{blocked}</div></div>
        <div className="card"><div className="label">Total balance</div><div className="stat">{eur(rows?.reduce((s, r) => s + r.balance, 0) ?? 0)}</div></div>
        <div className="card"><div className="label">Spend this period</div><div className="stat">{eur(rows?.reduce((s, r) => s + r.spent, 0) ?? 0)}</div></div>
      </div>
      <section className="card" aria-labelledby="cust-title" data-tour="admin">
        <form className="formrow" role="search" onSubmit={e => { e.preventDefault(); load(q); }}>
          <div><label className="f" htmlFor="q" id="cust-title">Search customers (name, email or id)</label><input id="q" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="e.g. lucia@" /></div>
          <button className="btn">Search</button>
        </form>
        <div className="tablewrap" tabIndex={0} style={{ marginTop: 12 }}><table>
          <caption className="sr-only">Customers</caption>
          <thead><tr><th scope="col">Customer</th><th scope="col">Plan</th><th scope="col" style={{ textAlign: "right" }}>Balance</th><th scope="col" style={{ textAlign: "right" }}>Spend this period</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {rows === null && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
            {rows?.length === 0 && <tr><td colSpan={5} className="muted">No customers.</td></tr>}
            {rows?.map(r => (
              <tr key={r.id} className="clickable">
                <td><Link href={`/admin/${encodeURIComponent(r.id)}`}><b>{r.name}</b></Link><div className="muted" style={{ fontSize: 12 }}>{r.email} · {r.id}</div></td>
                <td>{PLANS[r.plan].name}{r.pendingPlan && <div className="muted" style={{ fontSize: 12 }}>→ {PLANS[r.pendingPlan.plan].name}</div>}</td>
                <td style={{ textAlign: "right" }}>{eur(r.balance)}</td>
                <td style={{ textAlign: "right" }}>{eur(r.spent)}{r.spendCap !== undefined && <div className="muted" style={{ fontSize: 12 }}>limit {eur(r.spendCap)}</div>}</td>
                <td><Status r={r} /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </main>
  );
}

export default function Page() { return <AdminGate>{logout => <List logout={logout} />}</AdminGate>; }
