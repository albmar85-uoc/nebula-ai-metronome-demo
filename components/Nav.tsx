"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "./useAccount";
import ModeBadge from "./ModeBadge";
import { PLANS, eur } from "@/lib/catalog";

export default function Nav() {
  const { account, logout } = useAccount();
  const path = usePathname();
  const cur = (href: string) => (path?.startsWith(href) ? { className: "on", "aria-current": "page" as const } : {});
  return (
    <header>
      <nav className="nav" aria-label="Main">
        <Link href="/" className="logo" aria-label="nebula.ai, home">nebula<span>.ai</span></Link>
        <ModeBadge />
        <div className="links">
          <Link href="/#pricing">Pricing</Link>
          {account && <Link href="/dashboard" {...cur("/dashboard")}>Usage</Link>}
          {account && <Link href="/billing" {...cur("/billing")}>Billing</Link>}
          {account && <Link href="/keys" {...cur("/keys")}>API keys</Link>}
          <Link href="/docs" {...cur("/docs")}>Docs</Link>
        </div>
        <div className="right">
          {account ? (
            <>
              <span className="badge acc hide-sm">{PLANS[account.plan].name}</span>
              <span className={`badge ${account.blocked ? "bad" : ""}`} aria-label={`Balance: ${eur(account.balance)}${account.blocked ? ", access paused" : ""}`}>{eur(account.balance)}</span>
              <button className="btn small" onClick={logout}>Sign out</button>
            </>
          ) : (
            <Link href="/signup" className="btn primary small">Start free</Link>
          )}
        </div>
      </nav>
    </header>
  );
}
