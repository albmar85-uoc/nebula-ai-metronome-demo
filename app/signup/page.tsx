"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PLANS, eur, type PlanId } from "@/lib/catalog";
import { api, useConfig } from "@/components/useAccount";
import ModeBadge from "@/components/ModeBadge";

const ERRORS: Record<string, string> = { stripe: "No se pudo guardar la tarjeta en Stripe. Inténtalo de nuevo.", datos: "Faltan datos del alta. Vuelve a empezar." };

function SignupForm() {
  const sp = useSearchParams();
  const router = useRouter();
  const cfg = useConfig();
  const live = !!cfg?.stripeCheckout;
  const [plan, setPlan] = useState<PlanId>((sp.get("plan") as PlanId) in PLANS ? (sp.get("plan") as PlanId) : "free");
  const [name, setName] = useState("Alberto");
  const [email, setEmail] = useState("alberto@example.com");
  const [card, setCard] = useState("4242 4242 4242 4242");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(ERRORS[sp.get("error") ?? ""] ?? (sp.get("cancelado") ? "Has cancelado el paso de Stripe. No se ha creado la cuenta." : ""));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      if (live) {
        // Modo en vivo: Stripe Checkout en modo "setup" guarda la tarjeta y vuelve a /api/stripe/return.
        const r = await fetch("/api/stripe/setup-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, plan }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Error");
        window.location.href = j.url;
        return;
      }
      await api("/api/signup", { name, email, plan });
      router.push("/dashboard");
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <main className="wrap" style={{ maxWidth: 560 }}>
      <div className="row"><h2 className="sp">Crea tu cuenta</h2><ModeBadge /></div>
      <form className="card" onSubmit={submit}>
        <label className="f" htmlFor="name">Nombre</label><input id="name" value={name} onChange={e => setName(e.target.value)} required />
        <label className="f" htmlFor="email">Email</label><input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
        <label className="f" htmlFor="plan">Plan</label>
        <select id="plan" value={plan} onChange={e => setPlan(e.target.value as PlanId)}>
          {Object.values(PLANS).map(p => <option key={p.id} value={p.id}>{p.name} · {eur(p.monthlyFee)}/mes · {eur(p.monthlyCredits)} en créditos</option>)}
        </select>
        {live ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>Al continuar irás a Stripe Checkout para guardar tu tarjeta (no se cobra nada en ese paso).</p>
        ) : (
          <>
            <label className="f" htmlFor="card">Tarjeta (simulada; en vivo se usa Stripe Checkout en modo guardar tarjeta)</label>
            <input id="card" value={card} onChange={e => setCard(e.target.value)} inputMode="numeric" autoComplete="off" />
          </>
        )}
        <p className="muted" style={{ fontSize: 13 }}>Guardamos la tarjeta para que Metronome cobre la cuota, las recargas y el uso extra. {PLANS[plan].monthlyFee > 0 ? `Tras el alta se cobran ${eur(PLANS[plan].monthlyFee)} (prorrateados si no empiezas a principio de mes${live ? "" : "; en la simulación, el mes completo"}).` : "Hoy no se cobra nada."}</p>
        {err && <div className="banner bad">{err}</div>}
        <button className="btn primary" style={{ width: "100%", marginTop: 8 }} disabled={busy || !cfg}>{busy ? (live ? "Abriendo Stripe…" : "Creando cuenta…") : live ? "Continuar a Stripe" : "Crear cuenta"}</button>
      </form>
    </main>
  );
}

export default function Signup() { return <Suspense><SignupForm /></Suspense>; }
