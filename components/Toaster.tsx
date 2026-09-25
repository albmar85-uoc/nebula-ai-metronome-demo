"use client";
import { useEffect, useRef, useState } from "react";
import { onToast, takePendingToasts, type ToastKind, type ToastMsg } from "./toast";
import { api, useAccount, useConfig } from "./useAccount";
import type { Alert } from "@/lib/billing/types";

const ALERT_STYLE: Record<Alert["type"], { title: string; kind: ToastKind }> = {
  low_balance: { title: "Low balance", kind: "warn" },
  zero_balance: { title: "Balance used up", kind: "bad" },
  auto_recharge: { title: "Auto-recharge", kind: "info" },
  payment: { title: "Payment", kind: "info" },
  spend_cap: { title: "Spend limit", kind: "warn" },
  support: { title: "From support", kind: "ok" },
  info: { title: "Update", kind: "info" },
};
const ICON: Record<ToastKind, string> = { info: "i", ok: "✓", warn: "!", bad: "×" };
const MAX = 4;

/**
 * Presentation-friendly notifications: every new account alert (local or Metronome webhook) pops up as a toast,
 * plus toasts from actions (demo controls, etc.). Polls the account while the tab is visible so alerts caused
 * outside the page (curl against /api/v1, webhooks, admin actions) show up without a refresh.
 */
export default function Toaster() {
  const { account } = useAccount();
  const cfg = useConfig();
  const [items, setItems] = useState<(ToastMsg & { leaving?: boolean })[]>([]);
  const seen = useRef<{ customer?: string; ids: Set<string>; messages: Map<string, number> }>({ ids: new Set(), messages: new Map() });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = (id: string) => {
    setItems(list => list.map(t => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setItems(list => list.filter(t => t.id !== id)), 200);
    const tm = timers.current.get(id); if (tm) clearTimeout(tm); timers.current.delete(id);
  };
  const push = (t: ToastMsg) => {
    // The same text within a few seconds (e.g. an action summary that is also stored as an alert) is shown once.
    const last = seen.current.messages.get(t.message);
    if (last && Date.now() - last < 8000) return;
    seen.current.messages.set(t.message, Date.now());
    setItems(list => [...list.filter(x => x.id !== t.id), t].slice(-MAX));
    timers.current.set(t.id, setTimeout(() => dismiss(t.id), t.ttl ?? (t.kind === "bad" || t.kind === "warn" ? 9000 : 7000)));
  };

  useEffect(() => {
    const off = onToast(push);
    takePendingToasts().forEach((t, i) => push({ ...t, id: `p_${i}_${Date.now()}` }));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New alerts → toasts (existing ones on first load are not replayed).
  useEffect(() => {
    if (!account) return;
    const s = seen.current;
    const fresh = s.customer === account.customerId;
    if (!fresh) { s.customer = account.customerId; s.ids = new Set(account.alerts.map(a => a.id)); return; }
    for (const al of [...account.alerts].reverse()) {
      if (s.ids.has(al.id)) continue;
      s.ids.add(al.id);
      const st = ALERT_STYLE[al.type] ?? ALERT_STYLE.info;
      push({ id: al.id, title: al.source === "webhook" ? `${st.title} · Metronome webhook` : st.title, message: al.message, kind: st.kind });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  // Light polling while visible (mock: 5 s; live: 20 s, to spare Metronome API calls).
  const signedIn = !!account;
  useEffect(() => {
    if (!signedIn || !cfg) return;
    const every = cfg.mode === "mock" ? 5000 : 20000;
    const t = setInterval(() => { if (document.visibilityState === "visible") api("/api/me").catch(() => {}); }, every);
    return () => clearInterval(t);
  }, [signedIn, cfg]);

  return (
    <section className="toasts" aria-label="Notifications" aria-live="polite" aria-relevant="additions">
      {items.map(t => (
        <div key={t.id} className={`toast ${t.kind}${t.leaving ? " leaving" : ""}`} data-testid="toast">
          <span className="ticon" aria-hidden="true">{ICON[t.kind]}</span>
          <div className="tbody"><b>{t.title}</b><div>{t.message}</div></div>
          <button className="tclose" onClick={() => dismiss(t.id)} aria-label={`Dismiss notification: ${t.title}`}>×</button>
        </div>
      ))}
    </section>
  );
}
