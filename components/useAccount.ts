"use client";
import { useCallback, useEffect, useState } from "react";
import type { Account } from "@/lib/billing/types";

export type AccountView = Account & { balance: number };
const listeners = new Set<(a: AccountView | null) => void>();
let cache: AccountView | null = null;
const publish = (a: AccountView | null) => { cache = a; listeners.forEach(l => l(a)); };

export async function api(path: string, body?: unknown) {
  const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Error");
  if (data.customerId) publish(data);
  return data;
}

export function useAccount() {
  const [account, setAccount] = useState<AccountView | null>(cache);
  const [loading, setLoading] = useState(!cache);
  useEffect(() => {
    listeners.add(setAccount);
    if (!cache) api("/api/me").catch(() => publish(null)).finally(() => setLoading(false));
    else setLoading(false);
    return () => { listeners.delete(setAccount); };
  }, []);
  const logout = useCallback(async () => { await fetch("/api/me", { method: "DELETE" }); publish(null); location.href = "/"; }, []);
  return { account, loading, logout };
}

export type AppConfig = { mode: "mock" | "metronome"; stripeCheckout: boolean };
let cfgCache: AppConfig | null = null;
let cfgPromise: Promise<AppConfig> | null = null;
/** Modo de la demo (simulado / en vivo), leído en tiempo de ejecución desde /api/config. */
export function useConfig() {
  const [cfg, setCfg] = useState<AppConfig | null>(cfgCache);
  useEffect(() => {
    if (cfgCache) return;
    cfgPromise ??= fetch("/api/config", { cache: "no-store" }).then(r => r.json()).then(c => (cfgCache = c));
    cfgPromise.then(setCfg).catch(() => setCfg({ mode: "mock", stripeCheckout: false }));
  }, []);
  return cfg;
}
