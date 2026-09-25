"use client";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Lightweight guided tour (no dependencies): each step names a page and a [data-tour] anchor, dims the rest of the
// screen with a ring around the anchor and explains which Metronome feature is behind it. Progress lives in
// localStorage so the tour survives page navigations. Start it from Demo controls or with ?tour=1.
export type TourStep = { id: string; path: string; title: string; body: string; metronome: string };
export const TOUR: TourStep[] = [
  { id: "pricing", path: "/", title: "Pricing", body: "Free, Pro and Scale are self-serve usage plans with monthly credits and a usage discount. Enterprise is an annual commitment.", metronome: "Rate card with per-metric prices, one contract per customer, recurring credits and subscription fees." },
  { id: "signup", path: "/signup", title: "Sign-up", body: "Pick a plan; in live mode Stripe Checkout saves the card and the customer is created in Metronome.", metronome: "Customer with Stripe billing config + a plan contract (idempotent via uniqueness_key). First month prorated." },
  { id: "usage", path: "/dashboard", title: "Usage", body: "Send simulated requests, or call the public API with an API key. Each request becomes one usage event.", metronome: "Ingest API: one event per request, transaction_id = request id (idempotent retries). Billable metrics for tokens and images." },
  { id: "alerts", path: "/dashboard", title: "Alerts", body: "Low balance at 20% of plan credits, €0 balance, auto-recharge, spend limit and payment notices. They also pop up as notifications.", metronome: "Balance alerts delivered as webhooks; the €0 alert cuts API access on Free/Pro." },
  { id: "upgrade", path: "/billing", title: "Upgrade", body: "Upgrades apply now: the prorated fee difference is charged, the whole balance carries over and the new plan's credits arrive prorated.", metronome: "Contract transition (RENEWAL) with rollover of credits and commits; downgrades are scheduled for the next period." },
  { id: "bundle", path: "/billing", title: "Bundles", body: "Prepaid balance with a bonus: pay €200 and get €230, valid 12 months. Auto-recharge (below €10 → back to €50) lives here too.", metronome: "Prepaid commit behind a Stripe payment gate; the bonus credit is granted after the payment webhook." },
  { id: "promo", path: "/billing", title: "Promo codes", body: "WELCOME10 or LAUNCH25 add expiring credit, once per customer.", metronome: "Promotional credit with an expiry date and burn-down priority (plan → promo → gift → paid commits)." },
  { id: "invoice-preview", path: "/dashboard", title: "Next invoice", body: "A live preview of the next invoice: usage by metric, discounts, credits applied and next month's fee.", metronome: "Draft invoice for the current period, updated in real time as usage is ingested." },
  { id: "api-key", path: "/keys", title: "API keys", body: "Developers create named keys (shown once, stored hashed) and call /api/v1/completions and /api/v1/images.", metronome: "Every API call goes through the same ingest path, so billing is identical to what customers really use." },
  { id: "admin", path: "/admin", title: "Support panel", body: "Support looks up any customer, sees balance, credits, invoices and history, and grants goodwill credit, unblocks or changes plan.", metronome: "Credits via the contract API, plan changes via transitions; every action is logged and shown to the customer." },
];
const KEY = "nebula-tour";
const EVT = "nebula:tour";

export function startTour(step = 0) {
  try { localStorage.setItem(KEY, String(step)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVT));
}
const readStep = () => { try { const v = localStorage.getItem(KEY); return v === null ? null : Math.max(0, Math.min(TOUR.length - 1, Number(v) || 0)); } catch { return null; } };

type Rect = { top: number; left: number; width: number; height: number };

export default function Tour() {
  const router = useRouter();
  const pathname = usePathname();
  const [idx, setIdx] = useState<number | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const [vw, setVw] = useState(1024);
  const box = useRef<HTMLDivElement>(null);
  const step = idx === null ? null : TOUR[idx];

  useEffect(() => {
    const sync = () => setIdx(readStep());
    if (new URLSearchParams(location.search).get("tour") === "1" && readStep() === null) startTour(0);
    sync();
    window.addEventListener(EVT, sync);
    return () => window.removeEventListener(EVT, sync);
  }, []);

  const go = useCallback((n: number | null) => {
    try { if (n === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(n)); } catch { /* ignore */ }
    setRect(null); setMissing(false); setIdx(n);
  }, []);

  // Navigate to the step's page, then find its anchor.
  useEffect(() => {
    if (!step) return;
    if (pathname !== step.path) { router.push(step.path); return; }
    let tries = 0, el: Element | null = null;
    const find = setInterval(() => {
      el = document.querySelector(`[data-tour="${step.id}"]`);
      if (el || ++tries > 30) {
        clearInterval(find);
        if (!el) { setMissing(true); setRect(null); return; }
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        setTimeout(measure, 380);
      }
    }, 150);
    const measure = () => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      setVw(window.innerWidth);
    };
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => { clearInterval(find); window.removeEventListener("scroll", measure); window.removeEventListener("resize", measure); };
  }, [step, pathname, router]);

  useLayoutEffect(() => { if (step && (rect || missing)) box.current?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true }); }, [step, rect === null, missing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (idx === null) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, select");
      if (e.key === "Escape") go(null);
      else if (!typing && e.key === "ArrowRight") go(idx < TOUR.length - 1 ? idx + 1 : null);
      else if (!typing && e.key === "ArrowLeft" && idx > 0) go(idx - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, go]);

  if (!step || idx === null || (!rect && !missing)) return null;
  const pad = 8;
  const POP_H = 290; // approx. popover height
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const spaceBelow = rect ? vh - (rect.top + rect.height + pad + 10) : 0;
  const spaceAbove = rect ? rect.top - pad - 10 : 0;
  const place = !rect || vw < 640 ? "sheet" : spaceBelow >= POP_H ? "below" : spaceAbove >= POP_H ? "above" : "sheet";
  const style: React.CSSProperties = place === "sheet" || !rect
    ? {}
    : { position: "fixed", top: place === "below" ? rect.top + rect.height + pad + 10 : undefined, bottom: place === "above" ? vh - rect.top + pad + 10 : undefined, left: Math.max(12, Math.min(rect.left, vw - 392)) };
  const last = idx === TOUR.length - 1;
  return (
    <>
      {rect && <div className="tour-ring" aria-hidden="true" style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />}
      {!rect && <div className="tour-dim" aria-hidden="true" />}
      <div ref={box} className={`tour-pop${place === "sheet" ? " sheet" : ""}`} style={style} role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body" data-testid="tour">
        <div className="row" style={{ marginBottom: 4 }}><span className="muted sp" style={{ fontSize: 12 }}>Guided tour · step {idx + 1} of {TOUR.length}</span>
          <button className="tclose" onClick={() => go(null)} aria-label="End tour">×</button></div>
        <h2 id="tour-title" tabIndex={-1}>{step.title}</h2>
        <p id="tour-body">{step.body}</p>
        <p className="tour-met"><b>Metronome:</b> {step.metronome}</p>
        {missing && <p className="muted" style={{ fontSize: 12 }}>This part of the page isn&apos;t visible right now (sign in or pick a persona in Demo controls).</p>}
        <div className="dots" aria-hidden="true">{TOUR.map((s, i) => <i key={s.id} className={i === idx ? "on" : ""} />)}</div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn small" onClick={() => go(idx - 1)} disabled={idx === 0}>Back</button>
          <span className="sp" />
          <button className="btn small" onClick={() => go(null)}>End tour</button>
          <button className="btn small primary" onClick={() => go(last ? null : idx + 1)}>{last ? "Finish" : "Next"}</button>
        </div>
      </div>
    </>
  );
}
