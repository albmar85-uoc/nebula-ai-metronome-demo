"use client";
import Link from "next/link";
import { useAccount, type AccountView } from "./useAccount";

export default function Guard({ children }: { children: (a: AccountView) => React.ReactNode }) {
  const { account, loading } = useAccount();
  if (loading) return <main className="wrap muted">Cargando…</main>;
  if (!account) return <main className="wrap"><div className="card">No has iniciado sesión. <Link href="/signup" className="btn primary small">Crear cuenta</Link></div></main>;
  return <>{children(account)}</>;
}
