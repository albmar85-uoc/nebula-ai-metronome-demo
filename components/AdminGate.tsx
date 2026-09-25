"use client";
import { useEffect, useState } from "react";

/** Pide la contraseña de soporte (ADMIN_PASSWORD) antes de mostrar el panel. */
export default function AdminGate({ children }: { children: (logout: () => void) => React.ReactNode }) {
  const [state, setState] = useState<"?" | "no" | "yes">("?");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => { fetch("/api/admin/login", { cache: "no-store" }).then(r => r.json()).then(j => setState(j.admin ? "yes" : "no")).catch(() => setState("no")); }, []);
  async function login(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    const r = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (r.ok) { setState("yes"); setPw(""); } else setErr((await r.json()).error ?? "Error");
  }
  const logout = async () => { await fetch("/api/admin/login", { method: "DELETE" }); setState("no"); };
  if (state === "?") return <main className="wrap muted">Loading…</main>;
  if (state === "no") return (
    <main className="wrap" style={{ maxWidth: 440 }}>
      <h2>Support panel</h2>
      <form className="card" onSubmit={login} data-tour="admin">
        <label className="f" htmlFor="adminpw">Support password</label>
        <input id="adminpw" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} required aria-describedby="adminpw-help" />
        <p id="adminpw-help" className="muted" style={{ fontSize: 12 }}>Demo: <code>ADMIN_PASSWORD</code> environment variable (default listed in the README).</p>
        <div role="alert">{err && <div className="banner bad">{err}</div>}</div>
        <button className="btn primary" style={{ width: "100%" }}>Sign in</button>
      </form>
    </main>
  );
  return <>{children(logout)}</>;
}
