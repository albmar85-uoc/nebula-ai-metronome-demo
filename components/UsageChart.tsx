"use client";
import { useMemo, useState } from "react";
import { METRICS, eur, type MetricId } from "@/lib/catalog";
import type { DailyUsage } from "@/lib/billing/types";
import type { UsageLast30Days } from "@/lib/billing/metronome-types";

const COLORS: Record<MetricId, string> = { input_tokens: "#7c5cff", output_tokens: "#22d3a6", images: "#f5a524" };
const fmt = (n: number) => new Intl.NumberFormat("en-US", { notation: n >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
type Mode = "cost" | MetricId;

/**
 * Uso diario de los últimos 30 días. Cantidades: UsageLast30Days (en vivo sale de POST /v1/usage con window_size DAY).
 * Coste: agregados diarios con el descuento del plan (en vivo, estimado a partir de la copia local de eventos).
 */
export default function UsageChart({ usage30, daily }: { usage30?: UsageLast30Days; daily: DailyUsage[] }) {
  const [mode, setMode] = useState<Mode>("cost");
  const metrics = Object.keys(METRICS) as MetricId[];
  const rows = useMemo(() => {
    const days = usage30?.metrics.input_tokens.daily.map(d => d.day.slice(0, 10))
      ?? Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10));
    return days.map(day => {
      const v = {} as Record<MetricId, { q: number; c: number }>;
      for (const m of metrics) {
        const q = usage30?.metrics[m].daily.find(d => d.day.slice(0, 10) === day)?.value ?? daily.filter(r => r.day === day && r.metric === m).reduce((s, r) => s + r.quantity, 0);
        const localCost = daily.filter(r => r.day === day && r.metric === m).reduce((s, r) => s + r.cost, 0);
        v[m] = { q, c: localCost || q * METRICS[m].pricePerUnit };
      }
      const d = new Date(`${day}T00:00:00Z`);
      return { day, label: d.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" }), dayNum: d.getUTCDate(), v };
    });
  }, [usage30, daily]); // eslint-disable-line react-hooks/exhaustive-deps
  const val = (r: (typeof rows)[number]) => (mode === "cost" ? metrics.reduce((s, m) => s + r.v[m].c, 0) : r.v[mode].q);
  const max = Math.max(...rows.map(val), mode === "cost" ? 0.01 : 1);
  const total = rows.reduce((s, r) => s + val(r), 0);
  const peak = rows.reduce((p, r) => (val(r) > val(p) ? r : p), rows[0]);
  return (
    <div>
      <div className="row tabs" role="group" aria-label="Chart metric">
        <button type="button" aria-pressed={mode === "cost"} className={`chip ${mode === "cost" ? "on" : ""}`} onClick={() => setMode("cost")}>Cost</button>
        {metrics.map(m => <button type="button" key={m} aria-pressed={mode === m} className={`chip ${mode === m ? "on" : ""}`} onClick={() => setMode(m)}><i style={{ background: COLORS[m] }} />{METRICS[m].name}</button>)}
        <span className="sp" />
        <span className="muted" style={{ fontSize: 13 }}>30 days · {mode === "cost" ? eur(total) : `${fmt(total)} ${METRICS[mode].unit}`}</span>
      </div>
      <div className="hchart h30" role="img" aria-label={`Daily usage over the last 30 days (${mode === "cost" ? "cost" : METRICS[mode].name}): total ${mode === "cost" ? eur(total) : `${fmt(total)} ${METRICS[mode].unit}`}; busiest day: ${peak.label} (${mode === "cost" ? eur(val(peak)) : fmt(val(peak))}).`}>
        {rows.map((r, i) => {
          const t = val(r);
          const title = mode === "cost" ? `${r.label}: ${eur(t)}\n` + metrics.map(m => `${METRICS[m].name}: ${eur(r.v[m].c)}`).join("\n") : `${r.label}: ${fmt(t)} ${METRICS[mode].unit}`;
          return (
            <div key={r.day} className="col" title={title} aria-hidden="true">
              <div className="stack" style={{ height: `${(t / max) * 100}%` }}>
                {mode === "cost"
                  ? metrics.map(m => r.v[m].c > 0 && <i key={m} style={{ flexGrow: r.v[m].c, background: COLORS[m] }} />)
                  : <i style={{ flexGrow: 1, background: COLORS[mode] }} />}
              </div>
              <span className={i % 5 === 4 || i === rows.length - 1 ? "" : "hide"}>{r.dayNum}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
