"use client";
import Link from "next/link";
import { useAccount, type AccountView } from "./useAccount";

export default function Guard({ children }: { children: (a: AccountView) => React.ReactNode }) {
  const { account, loading } = useAccount();
  if (loading) return <main className="wrap muted">Loading…</main>;
  if (!account) return <main className="wrap"><div className="card">You are not signed in. <Link href="/signup" className="btn primary small">Create account</Link></div></main>;
  return <>{children(account)}</>;
}
