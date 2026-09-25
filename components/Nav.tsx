"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "./useAccount";
import ModeBadge from "./ModeBadge";
import { PLANS, eur } from "@/lib/catalog";

export default function Nav() {
  const { account, logout } = useAccount();
  const path = usePathname();
  const cls = (href: string) => (path?.startsWith(href) ? "on" : "");
  return (
    <nav className="nav">
      <Link href="/" className="logo">nebula<span>.ai</span></Link>
      <ModeBadge />
      <div className="links">
        <Link href="/#precios">Precios</Link>
        {account && <Link href="/dashboard" className={cls("/dashboard")}>Consumo</Link>}
        {account && <Link href="/billing" className={cls("/billing")}>Facturación</Link>}
      </div>
      <div className="right">
        {account ? (
          <>
            <span className="badge acc hide-sm">{PLANS[account.plan].name}</span>
            <span className={`badge ${account.blocked ? "bad" : ""}`}>{eur(account.balance)}</span>
            <button className="btn small" onClick={logout}>Salir</button>
          </>
        ) : (
          <Link href="/signup" className="btn primary small">Empezar gratis</Link>
        )}
      </div>
    </nav>
  );
}
