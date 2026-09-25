"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast, toastAfterReload } from "./toast";
import { startTour } from "./Tour";
import { api, useAccount, useConfig } from "./useAccount";
import type { Persona, PersonaId } from "@/lib/personas";

type State = { clock: { offsetMs: number; now: string }; current: PersonaId | null; signedIn: boolean; personas: (Persona & { seeded: boolean })[] };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Presenter drawer (mock mode only): personas, fast-forward to month end, traffic spike, guided tour and reset.
 * Toggle with the floating button or Shift+D.
 */
export default function DemoControls() {
  const cfg = useConfig();
  const { account } = useAccount();
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<State | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const mock = cfg?.mode === "mock";

  const load = useCallback(() => fetch("/api/demo/controls", { cache: "no-store" }).then(r => (r.ok ? r.json() : null)).then(setS).catch(() => {}), []);
  useEffect(() => { if (open && mock) load(); }, [open, mock, load, account?.customerId]);
  useEffect(() => { if (open) panel.current?.querySelector<HTMLElement>("h2")?.focus(); else setConfirmReset(false); }, [open]);
  useEffect(() => {
    if (!mock) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, select");
      if (e.key === "Escape" && open) { setOpen(false); opener.current?.focus(); }
      else if (!typing && e.shiftKey && (e.key === "D" || e.key === "d")) setOpen(o => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mock, open]);

  if (!mock) return null;

  async function run(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action + (extra.persona ?? "")); setMsg(null);
    try {
      const r = await fetch("/api/demo/controls", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Error");
      if (data.redirect) {
        toastAfterReload({ title: action === "reset" ? "Demo reset" : "Persona", message: data.summary, kind: "ok" });
        location.href = data.redirect;
        return;
      }
      setMsg({ ok: true, text: data.summary });
      toast({ title: action === "spike" ? "Traffic spike" : "Month end", message: data.summary, kind: action === "spike" && data.rejected ? "bad" : "info" });
      await api("/api/me").catch(() => {}); // refresh every open view (balance, invoices, alerts)
      load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally { setBusy(null); }
  }

  const plan = account?.plan;
  const spikeHint = plan === "scale" ? "Pushes overage past the next €300 step: Metronome charges it early (spend threshold)."
    : plan === "pro" ? (account?.autoRecharge ? "Drains the balance below €10: auto-recharge tops it back up to €50." : "Drains the balance; with auto-recharge off, API access pauses at €0.")
    : plan === "free" ? "Uses up the Free credits: API access pauses at €0 (402)." : "Pick a persona first.";

  return (
    <>
      <button ref={opener} className="demo-fab" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls="demo-drawer">
        <span aria-hidden="true">⚙</span> Demo controls
      </button>
      {open && (
        <div id="demo-drawer" ref={panel} className="drawer" role="dialog" aria-modal="false" aria-labelledby="demo-title" data-testid="demo-drawer">
          <div className="row"><h2 id="demo-title" className="sp" tabIndex={-1}>Demo controls</h2>
            <button className="tclose" onClick={() => { setOpen(false); opener.current?.focus(); }} aria-label="Close demo controls">×</button></div>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Simulated (mock) mode only · Shift+D toggles this panel.</p>
          {s && <p className="clock" data-testid="demo-clock">Demo date: <b>{day(s.clock.now)}</b>{s.clock.offsetMs > 0 && <span className="muted"> · {Math.round(s.clock.offsetMs / 86400000)} days ahead</span>}</p>}

          <h3>Personas</h3>
          <div className="personas" role="group" aria-label="Personas">
            {(s?.personas ?? []).map(p => (
              <button key={p.id} className={`persona${s?.current === p.id ? " on" : ""}`} aria-pressed={s?.current === p.id} disabled={!!busy} onClick={() => run("persona", { persona: p.id })}>
                <b>{p.title}</b>
                <span>{p.name} · {p.company}</span>
                <small>{busy === "persona" + p.id ? "Loading…" : p.blurb}</small>
              </button>
            ))}
          </div>

          <h3>Time and traffic</h3>
          <div className="ctl">
            <button className="btn small primary" disabled={!!busy || !account} onClick={() => run("fast-forward")}>{busy === "fast-forward" ? "Closing month…" : "Fast-forward to month end"}</button>
            <p>Runs the month close: overage invoice, unused plan credits expire, new fee and recurring credits.</p>
          </div>
          <div className="ctl">
            <button className="btn small primary" disabled={!!busy || !account} onClick={() => run("spike")}>{busy === "spike" ? "Sending…" : "Traffic spike"}</button>
            <p>{spikeHint}</p>
          </div>

          <h3>Presenter</h3>
          <div className="ctl">
            <button className="btn small" onClick={() => { setOpen(false); startTour(0); }}>Start guided tour</button>
            <p>10 steps from pricing to the support panel. Arrow keys move, Esc ends.</p>
          </div>
          <div className="ctl">
            {!confirmReset
              ? <button className="btn small danger" disabled={!!busy} onClick={() => setConfirmReset(true)}>Reset demo data</button>
              : <button className="btn small danger" disabled={!!busy} onClick={() => run("reset", { persona: s?.current ?? "pro" })}>{busy?.startsWith("reset") ? "Resetting…" : "Confirm: erase everything"}</button>}
            <p>Erases all accounts, keys and history, resets the demo date and seeds the four personas again.</p>
          </div>
          <div role="status" aria-live="polite">{msg && <div className={`banner ${msg.ok ? "info" : "bad"}`} style={{ fontSize: 13 }}>{msg.text}</div>}</div>
        </div>
      )}
    </>
  );
}
