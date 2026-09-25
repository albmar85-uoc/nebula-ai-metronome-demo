import Link from "next/link";
import { BUNDLES, ENTERPRISE_EXAMPLE, METRICS, PLANS, SPEND_THRESHOLD, eur } from "@/lib/catalog";

const perUnit = (m: keyof typeof METRICS, price: number) => (m === "images" ? `${eur(price)} / imagen` : `${eur(price)} / millón`);

export default function Pricing() {
  return (
    <>
      <div className="grid g4 pricing">
        {Object.values(PLANS).map(p => (
          <div key={p.id} className={`card ${p.id === "pro" ? "hl" : ""}`}>
            <div className="row"><h3>{p.name}</h3>{p.id === "pro" && <span className="badge acc">Más popular</span>}</div>
            <div className="price">{eur(p.monthlyFee)} <small>/ mes</small></div>
            <ul className="clean">{p.features.map(f => <li key={f}>{f}</li>)}</ul>
            <Link href={`/signup?plan=${p.id}`} className={`btn ${p.id === "pro" ? "primary" : ""}`} style={{ width: "100%" }}>Elegir {p.name}</Link>
          </div>
        ))}
        <div className="card ent">
          <div className="row"><h3>Enterprise</h3><span className="badge">Anual</span></div>
          <div className="price" style={{ fontSize: 26 }}>A medida</div>
          <ul className="clean">
            <li>Compromiso de gasto anual (desde {eur(12_000)})</li>
            <li>Precios negociados por métrica</li>
            <li>Factura mensual a 30 días</li>
            <li>Soporte dedicado y SLA</li>
          </ul>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
            Ejemplo: {eur(ENTERPRISE_EXAMPLE.commitAmountEur)}/año · {ENTERPRISE_EXAMPLE.rateOverrides.map(o => perUnit(o.metric, o.priceEur)).join(" · ")}
          </p>
          <Link href="/enterprise" className="btn" style={{ width: "100%" }}>Hablar con ventas</Link>
        </div>
      </div>
      <div className="grid g2 sec">
        <div className="card">
          <h3>Precio por uso</h3>
          <table><tbody>{Object.values(METRICS).map(m => <tr key={m.name}><td>{m.name}</td><td style={{ textAlign: "right" }}>{m.display}</td></tr>)}</tbody></table>
          <p className="muted" style={{ fontSize: 13 }}>Pro tiene un 10 % de descuento y Scale un 20 % sobre estos precios. En Scale, si tu uso extra llega a {eur(SPEND_THRESHOLD.scaleThreshold)} en un mes, lo cobramos por adelantado.</p>
        </div>
        <div className="card">
          <h3>Bundles de saldo</h3>
          <table><tbody>{Object.values(BUNDLES).map(b => <tr key={b.id}><td>Pagas {eur(b.price)}</td><td style={{ textAlign: "right" }}>Recibes <b>{eur(b.credit)}</b> <span className="badge ok">+{eur(b.credit - b.price)}</span></td></tr>)}</tbody></table>
          <p className="muted" style={{ fontSize: 13 }}>Válidos 12 meses y se conservan si cambias de plan. En Pro y Scale puedes activar la recarga automática.</p>
        </div>
      </div>
    </>
  );
}
