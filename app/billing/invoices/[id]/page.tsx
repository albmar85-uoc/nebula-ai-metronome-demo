"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Guard from "@/components/Guard";
import { eur } from "@/lib/catalog";
import type { Invoice } from "@/lib/billing/types";
import type { AccountView } from "@/components/useAccount";

const STATUS: Record<Invoice["status"], { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "ok" }, pending: { label: "Payment pending", cls: "warn" }, draft: { label: "Draft (closes at month end)", cls: "" }, void: { label: "Void", cls: "bad" }, failed: { label: "Payment failed", cls: "bad" },
};
const TYPE: Record<NonNullable<Invoice["type"]>, string> = { subscription: "Subscription", commit: "Balance purchase", usage: "Usage", proration: "Plan change proration", threshold: "Early threshold charge" };
const d = (s?: string, utc = false) => (s ? new Date(s).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric", ...(utc ? { timeZone: "UTC" } : {}) }) : "—");
const qty = (n?: number) => (n === undefined ? "" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n));
const unit = (n?: number) => (n === undefined ? "" : n !== 0 && Math.abs(n) < 0.01 ? `€${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 }).format(n * 1_000_000)} / M` : eur(n));

function Detail({ id, a }: { id: string; a: AccountView }) {
  const [inv, setInv] = useState<Invoice | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch(`/api/invoices/${encodeURIComponent(id)}`, { cache: "no-store" }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); setInv(j); }).catch(e => setErr(e.message));
  }, [id, a.invoices.length]);
  if (err) return <main className="wrap"><Link href="/billing" className="muted">← Billing</Link><div className="banner bad" role="alert" style={{ marginTop: 16 }}>{err}</div></main>;
  if (!inv) return <main className="wrap muted">Loading invoice…</main>;
  const st = STATUS[inv.status];
  return (
    <main className="wrap" style={{ maxWidth: 820 }}>
      <Link href="/billing" className="muted">← Billing</Link>
      <div className="card invoice" style={{ marginTop: 14 }}>
        <div className="row">
          <div className="sp">
            <div className="logo">nebula<span>.ai</span></div>
            <div className="muted" style={{ fontSize: 13 }}>{inv.status === "draft" ? "Provisional invoice" : "Invoice"} · {inv.id}</div>
          </div>
          <span className={`badge ${st.cls}`}>{st.label}</span>
        </div>
        {inv.status === "failed" && <div className="banner bad" role="alert" style={{ marginTop: 16 }}>Payment failed: we couldn&apos;t charge your card for this invoice. Please check your payment method; our team has been notified.</div>}
        <div className="grid g3" style={{ margin: "20px 0" }}>
          <div><div className="label">Customer</div>{a.name}<div className="muted" style={{ fontSize: 13 }}>{a.email}</div></div>
          <div><div className="label">Date</div>{d(inv.date)}<div className="muted" style={{ fontSize: 13 }}>{inv.type ? TYPE[inv.type] : ""}</div></div>
          <div><div className="label">Period</div>{inv.periodStart ? `${d(inv.periodStart, true)} – ${d(inv.periodEnd ? new Date(+new Date(inv.periodEnd) - 1).toISOString() : undefined, true)}` : "—"}</div>
        </div>
        <div className="tablewrap" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Description</th><th scope="col" style={{ textAlign: "right" }}>Quantity</th><th scope="col" style={{ textAlign: "right" }}>Price</th><th scope="col" style={{ textAlign: "right" }}>Amount</th></tr></thead>
            <tbody>
              {(inv.lines ?? []).length === 0 && <tr><td colSpan={4} className="muted">No lines yet.</td></tr>}
              {(inv.lines ?? []).map((l, i) => (
                <tr key={i} className={l.amount < 0 ? "neg" : ""}>
                  <td>{l.description}</td><td style={{ textAlign: "right" }}>{qty(l.quantity)}</td><td style={{ textAlign: "right" }}>{unit(l.unitPrice)}</td><td style={{ textAlign: "right" }}>{eur(l.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={3} style={{ textAlign: "right" }}><b>Total {inv.status === "draft" ? "due if the month ended today" : ""}</b></td><td style={{ textAlign: "right" }}><b>{eur(inv.amount)}</b></td></tr></tfoot>
          </table>
        </div>
        <div className="row" style={{ marginTop: 18 }}>
          <div className="sp muted" style={{ fontSize: 13 }}>
            {inv.externalId && <>Stripe payment reference: <code>{inv.externalId}</code><br /></>}
            {a.mode === "mock" ? "Simulated invoice: in production Metronome issues it and Stripe collects it." : "Data from Metronome (GET /v1/customers/{id}/invoices/{invoice_id})."}
          </div>
          {inv.pdfUrl && <a className="btn small" href={inv.pdfUrl} target="_blank" rel="noreferrer">PDF</a>}
          <button className="btn small" onClick={() => window.print()}>Print</button>
        </div>
      </div>
    </main>
  );
}

export default function Page({ params }: { params: { id: string } }) {
  return <Guard>{a => <Detail id={decodeURIComponent(params.id)} a={a} />}</Guard>;
}
