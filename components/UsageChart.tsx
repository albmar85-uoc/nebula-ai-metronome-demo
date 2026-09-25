"use client";
import { useMemo, useState } from "react";
import { METRICS, eur, type MetricId } from "@/lib/catalog";
import type { DailyUsage } from "@/lib/billing/types";

const COLORS: Record<MetricId, string> = { input_tokens: "#7c5cff", output_tokens: "#22d3a6", images: "#f5a524" };
const fmt = (n: number) => new Intl.NumberFormat("es-ES", { notation: n >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
type Mode = "cost" | MetricId;

/** Histórico de uso por día: coste apilado por métrica, o cantidad de una métrica concreta. */
export default function UsageChart({ daily, days = 14 }: { daily: DailyUsage[]; days?: number }) {
  const [mode, setMode] = useState<Mode>("cost");
  const rows = useMemo(() => {
    const out: { day: string; label: string; v: Record<MetricId, { q: number; c: number }> }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const day = d.toISOString().slice(0, 10);
      const v = { input_tokens: { q: 0, c: 0 }, output_tokens: { q: 0, c: 0 }, images: { q: 0, c: 0 } };
      for (const r of daily) if (r.day === day) { v[r.metric].q += r.quantity; v[r.metric].c += r.cost; }
      out.push({ day, label: d.toLocaleDateString("es-ES", { day: "numeric", month: "short" }), v });
    }
    return out;
  }, [daily, days]);
  const val = (r: (typeof rows)[number]) => (mode === "cost" ? (Object.values(r.v).reduce((s, x) => s + x.c, 0)) : r.v[mode].q);
  const max = Math.max(...rows.map(val), mode === "cost" ? 0.01 : 1);
  const total = rows.reduce((s, r) => s + val(r), 0);
  const metrics = Object.keys(METRICS) as MetricId[];
  return (
    <div>
      <div className="row tabs" role="tablist">
        <button role="tab" aria-selected={mode === "cost"} className={`chip ${mode === "cost" ? "on" : ""}`} onClick={() => setMode("cost")}>Coste</button>
        {metrics.map(m => <button key={m} role="tab" aria-selected={mode === m} className={`chip ${mode === m ? "on" : ""}`} onClick={() => setMode(m)}><i style={{ background: COLORS[m] }} />{METRICS[m].name}</button>)}
        <span className="sp" />
        <span className="muted" style={{ fontSize: 13 }}>{days} días · {mode === "cost" ? eur(total) : `${fmt(total)} ${METRICS[mode].unit}`}</span>
      </div>
      <div className="hchart" aria-label="Histórico de uso por día">
        {rows.map(r => {
          const t = val(r);
          const title = mode === "cost" ? `${r.label}: ${eur(t)}\n` + metrics.map(m => `${METRICS[m].name}: ${eur(r.v[m].c)}`).join("\n") : `${r.label}: ${fmt(t)} ${METRICS[mode].unit}`;
          return (
            <div key={r.day} className="col" title={title}>
              <div className="stack" style={{ height: `${(t / max) * 100}%` }}>
                {mode === "cost"
                  ? metrics.map(m => r.v[m].c > 0 && <i key={m} style={{ flexGrow: r.v[m].c, background: COLORS[m] }} />)
                  : <i style={{ flexGrow: 1, background: COLORS[mode] }} />}
              </div>
              <span>{r.label.split(" ")[0]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
