"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Guard from "@/components/Guard";
import type { AccountView } from "@/components/useAccount";
import type { PublicApiKey } from "@/lib/apikeys";

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }) : "—");

function Keys({ a }: { a: AccountView }) {
  const [keys, setKeys] = useState<PublicApiKey[]>([]);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<{ value: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const secretRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => { const r = await fetch("/api/keys", { cache: "no-store" }); if (r.ok) setKeys((await r.json()).keys); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (secret) secretRef.current?.focus(); }, [secret]);

  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy("new"); setCopied(false);
    try {
      const r = await fetch("/api/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setSecret({ value: j.secret, name: j.key.name }); setName(""); load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }
  async function revoke(k: PublicApiKey) {
    if (!confirm(`Revoke the key "${k.name}"? Apps using it will stop working immediately.`)) return;
    setBusy(k.id); setErr("");
    const r = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    if (!r.ok) setErr((await r.json()).error); else load();
    setBusy("");
  }
  const base = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
  return (
    <main className="wrap">
      <h2>API keys</h2>
      <p className="muted" style={{ marginTop: -8 }}>Use them in the <code>Authorization: Bearer …</code> header to call the nebula.ai API. All usage is billed to your account ({a.name}). <Link href="/docs"><u>Read the docs</u></Link></p>
      <div role="alert">{err && <div className="banner bad">{err}</div>}</div>

      {secret && (
        <div className="card hl" ref={secretRef} tabIndex={-1} aria-labelledby="secret-title" style={{ marginBottom: 16 }}>
          <h3 id="secret-title">Your new key "{secret.name}"</h3>
          <p className="muted" style={{ margin: "4px 0 0" }}>Copy it now: <b>we won't show it again</b>. We only store its fingerprint (hash).</p>
          <div className="secret"><code data-testid="api-key-secret">{secret.value}</code>
            <button className="btn small" onClick={async () => { await navigator.clipboard?.writeText(secret.value).catch(() => {}); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <span className="sr-only" role="status" aria-live="polite">{copied ? "Key copied to clipboard" : ""}</span>
          <pre><code>{`curl ${base}/api/v1/completions \\
  -H "Authorization: Bearer ${secret.value}" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt":"Hello, nebula","max_tokens":200}'`}</code></pre>
          <button className="btn small" onClick={() => setSecret(null)}>I've saved it</button>
        </div>
      )}

      <div className="grid g2x">
        <section className="card" aria-labelledby="keys-title">
          <h3 id="keys-title">Your keys</h3>
          <div className="tablewrap" tabIndex={0}><table>
            <caption className="sr-only">API keys</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Key</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {keys.length === 0 && <tr><td colSpan={5} className="muted">You don't have any keys yet.</td></tr>}
              {keys.map(k => (
                <tr key={k.id}>
                  <td>{k.name} {k.revokedAt && <span className="badge bad">revoked</span>}</td>
                  <td><code>{k.prefix}…</code></td>
                  <td>{fmt(k.createdAt)}</td>
                  <td>{fmt(k.lastUsedAt)}</td>
                  <td style={{ textAlign: "right" }}>{!k.revokedAt && <button className="btn small danger" disabled={busy === k.id} onClick={() => revoke(k)} aria-label={`Revoke key ${k.name}`}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
        <section className="card" aria-labelledby="new-title" data-tour="api-key">
          <h3 id="new-title">Create a key</h3>
          <form onSubmit={create}>
            <label className="f" htmlFor="keyname">Name (so you can recognize it)</label>
            <input id="keyname" value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="e.g. production server" required />
            <button className="btn primary" style={{ width: "100%", marginTop: 12 }} disabled={!!busy || !name.trim()}>{busy === "new" ? "Creating…" : "Create key"}</button>
          </form>
          <ul className="muted" style={{ fontSize: 13, paddingLeft: 18 }}>
            <li>Shown only once; if you lose it, revoke it and create another.</li>
            <li>Up to 10 active keys per account.</li>
            <li>Requests with a revoked key get <code>401</code>.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}

export default function Page() { return <Guard>{a => <Keys a={a} />}</Guard>; }
