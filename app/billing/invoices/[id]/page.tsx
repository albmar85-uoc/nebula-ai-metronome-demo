"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Guard from "@/components/Guard";
import { eur } from "@/lib/catalog";
import type { Invoice } from "@/lib/billing/types";
import type { AccountView } from "@/components/useAccount";

const STATUS: Record<Invoice["status"], { label: string; cls: string }> = {
  paid: { label: "Pagada", cls: "ok" }, pending: { label: "Pendiente de cobro", cls: "warn" }, draft: { label: "Borrador (se cierra a fin de mes)", cls: "" }, void: { label: "Anulada", cls: "bad" },
};
const TYPE: Record<NonNullable<Invoice["type"]>, string> = { subscription: "Suscripción", commit: "Compra de saldo", usage: "Uso", proration: "Prorrateo por cambio de plan", threshold: "Cobro anticipado por umbral" };
const d = (s?: string, utc = false) => (s ? new Date(s).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric", ...(utc ? { timeZone: "UTC" } : {}) }) : "—");
const qty = (n?: number) => (n === undefined ? "" : new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(n));
const unit = (n?: number) => (n === undefined ? "" : n !== 0 && Math.abs(n) < 0.01 ? `${new Intl.NumberFormat("es-ES", { maximumSignificantDigits: 3 }).format(n * 1_000_000)} € / M` : eur(n));

function Detail({ id, a }: { id: string; a: AccountView }) {
  const [inv, setInv] = useState<Invoice | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch(`/api/invoices/${encodeURIComponent(id)}`, { cache: "no-store" }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); setInv(j); }).catch(e => setErr(e.message));
  }, [id, a.invoices.length]);
  if (err) return <main className="wrap"><Link href="/billing" className="muted">← Facturación</Link><div className="banner bad" style={{ marginTop: 16 }}>{err}</div></main>;
  if (!inv) return <main className="wrap muted">Cargando factura…</main>;
  const st = STATUS[inv.status];
  return (
    <main className="wrap" style={{ maxWidth: 820 }}>
      <Link href="/billing" className="muted">← Facturación</Link>
      <div className="card invoice" style={{ marginTop: 14 }}>
        <div className="row">
          <div className="sp">
            <div className="logo">nebula<span>.ai</span></div>
            <div className="muted" style={{ fontSize: 13 }}>Factura {inv.status === "draft" ? "provisional" : ""} · {inv.id}</div>
          </div>
          <span className={`badge ${st.cls}`}>{st.label}</span>
        </div>
        <div className="grid g3" style={{ margin: "20px 0" }}>
          <div><div className="label">Cliente</div>{a.name}<div className="muted" style={{ fontSize: 13 }}>{a.email}</div></div>
          <div><div className="label">Fecha</div>{d(inv.date)}<div className="muted" style={{ fontSize: 13 }}>{inv.type ? TYPE[inv.type] : ""}</div></div>
          <div><div className="label">Periodo</div>{inv.periodStart ? `${d(inv.periodStart, true)} – ${d(inv.periodEnd ? new Date(+new Date(inv.periodEnd) - 1).toISOString() : undefined, true)}` : "—"}</div>
        </div>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Concepto</th><th style={{ textAlign: "right" }}>Cantidad</th><th style={{ textAlign: "right" }}>Precio</th><th style={{ textAlign: "right" }}>Importe</th></tr></thead>
            <tbody>
              {(inv.lines ?? []).length === 0 && <tr><td colSpan={4} className="muted">Sin líneas todavía.</td></tr>}
              {(inv.lines ?? []).map((l, i) => (
                <tr key={i} className={l.amount < 0 ? "neg" : ""}>
                  <td>{l.description}</td><td style={{ textAlign: "right" }}>{qty(l.quantity)}</td><td style={{ textAlign: "right" }}>{unit(l.unitPrice)}</td><td style={{ textAlign: "right" }}>{eur(l.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={3} style={{ textAlign: "right" }}><b>Total {inv.status === "draft" ? "a pagar si el mes acabara hoy" : ""}</b></td><td style={{ textAlign: "right" }}><b>{eur(inv.amount)}</b></td></tr></tfoot>
          </table>
        </div>
        <div className="row" style={{ marginTop: 18 }}>
          <div className="sp muted" style={{ fontSize: 13 }}>
            {inv.externalId && <>Referencia de pago en Stripe: <code>{inv.externalId}</code><br /></>}
            {a.mode === "mock" ? "Factura simulada: en producción la emite Metronome y la cobra Stripe." : "Datos de Metronome (GET /v1/customers/{id}/invoices/{invoice_id})."}
          </div>
          {inv.pdfUrl && <a className="btn small" href={inv.pdfUrl} target="_blank" rel="noreferrer">PDF</a>}
          <button className="btn small" onClick={() => window.print()}>Imprimir</button>
        </div>
      </div>
    </main>
  );
}

export default function Page({ params }: { params: { id: string } }) {
  return <Guard>{a => <Detail id={decodeURIComponent(params.id)} a={a} />}</Guard>;
}
