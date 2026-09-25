"use client";
/** Tiny toast bus (no dependencies). `toast()` works from anywhere on the client; <Toaster/> renders them. */
export type ToastKind = "info" | "ok" | "warn" | "bad";
export type ToastMsg = { id: string; title: string; message: string; kind: ToastKind; ttl?: number };
type Listener = (t: ToastMsg) => void;
const listeners = new Set<Listener>();
const PENDING = "nebula-pending-toasts";

export function toast(t: Omit<ToastMsg, "id"> & { id?: string }) {
  const msg = { id: t.id ?? `t_${Math.random().toString(36).slice(2, 9)}`, ...t };
  listeners.forEach(l => l(msg));
}
export const onToast = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** For actions that reload the page (persona switch, reset): shown by the Toaster after the next page load. */
export function toastAfterReload(t: Omit<ToastMsg, "id">) {
  try { const list = JSON.parse(sessionStorage.getItem(PENDING) ?? "[]"); list.push(t); sessionStorage.setItem(PENDING, JSON.stringify(list)); } catch { /* private mode */ }
}
export function takePendingToasts(): Omit<ToastMsg, "id">[] {
  try { const list = JSON.parse(sessionStorage.getItem(PENDING) ?? "[]"); sessionStorage.removeItem(PENDING); return list; } catch { return []; }
}
