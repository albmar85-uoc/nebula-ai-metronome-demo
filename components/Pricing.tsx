import Link from "next/link";
import { BUNDLES, METRICS, PLANS, eur } from "@/lib/catalog";

export default function Pricing() {
  return (
    <>
      <div className="grid g3">
        {Object.values(PLANS).map(p => (
          <div key={p.id} className={`card ${p.id === "pro" ? "hl" : ""}`}>
            <div className="row"><h3>{p.name}</h3>{p.id === "pro" && <span className="badge acc">Más popular</span>}</div>
            <div className="price">{eur(p.monthlyFee)} <small>/ mes</small></div>
            <ul className="clean">{p.features.map(f => <li key={f}>{f}</li>)}</ul>
            <Link href={`/signup?plan=${p.id}`} className={`btn ${p.id === "pro" ? "primary" : ""}`} style={{ width: "100%" }}>Elegir {p.name}</Link>
          </div>
        ))}
      </div>
      <div className="grid g2 sec">
        <div className="card">
          <h3>Precio por uso</h3>
          <table><tbody>{Object.values(METRICS).map(m => <tr key={m.name}><td>{m.name}</td><td style={{ textAlign: "right" }}>{m.display}</td></tr>)}</tbody></table>
          <p className="muted" style={{ fontSize: 13 }}>Pro tiene un 10 % de descuento y Scale un 20 % sobre estos precios.</p>
        </div>
        <div className="card">
          <h3>Bundles de saldo</h3>
          <table><tbody>{Object.values(BUNDLES).map(b => <tr key={b.id}><td>Pagas {eur(b.price)}</td><td style={{ textAlign: "right" }}>Recibes <b>{eur(b.credit)}</b> <span className="badge ok">+{eur(b.credit - b.price)}</span></td></tr>)}</tbody></table>
          <p className="muted" style={{ fontSize: 13 }}>En Pro y Scale puedes activar la recarga automática cuando el saldo baje de 10 €.</p>
        </div>
      </div>
    </>
  );
}
