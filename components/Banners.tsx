"use client";
import Link from "next/link";
import { LOW_BALANCE_RATIO, PLANS, eur } from "@/lib/catalog";
import { CAP_ALERT_RATIO } from "@/lib/billing/limits";
import type { AccountView } from "./useAccount";

function Main({ a }: { a: AccountView }) {
  if (a.blocked) return <div className="banner bad">Your balance is zero and API access is paused. <Link href="/billing"><u>Top up or upgrade</u></Link> to continue.</div>;
  if (a.balance <= 0 && PLANS[a.plan].overage) return <div className="banner warn">Balance used up. You have {eur(a.overageAccrued)} of overage, which will be billed at month end.</div>;
  if (a.balance < PLANS[a.plan].monthlyCredits * LOW_BALANCE_RATIO) return <div className="banner warn">Your balance is running low ({eur(a.balance)}). <Link href="/billing"><u>Buy a bundle</u></Link>.</div>;
  return null;
}

/** Avisos de estado de la cuenta. Región aria-live: los lectores de pantalla anuncian los cambios (bloqueo, límite…). */
export default function Banners({ a }: { a: AccountView }) {
  const cap = a.spendCap;
  return (
    <div role="status" aria-live="polite">
      {a.pendingPlan && <div className="banner info">Switch to the {PLANS[a.pendingPlan.plan].name} plan scheduled for {new Date(a.pendingPlan.effectiveAt).toLocaleDateString("en-US", { timeZone: "UTC" })}.</div>}
      {cap && a.capReached && <div className="banner bad">You've reached your monthly spend limit ({eur(cap.monthlyEur)}): the API rejects requests (402). <Link href="/billing#limit"><u>Change the limit</u></Link></div>}
      {cap && !a.capReached && a.spent >= cap.monthlyEur * CAP_ALERT_RATIO && <div className="banner warn">You've spent {eur(a.spent)} this month, {Math.floor((a.spent / cap.monthlyEur) * 100)}% of your {eur(cap.monthlyEur)} limit.</div>}
      <Main a={a} />
    </div>
  );
}
