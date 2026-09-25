import Link from "next/link";
import { AUTO_RECHARGE, BUNDLES, ENTERPRISE_EXAMPLE, METRICS, PLANS, SPEND_THRESHOLD, eur } from "@/lib/catalog";

const perUnit = (m: keyof typeof METRICS, price: number) => (m === "images" ? `${eur(price)} / image` : `${eur(price)} / million`);

export default function Pricing() {
  return (
    <>
      <div className="grid g4 pricing">
        {Object.values(PLANS).map(p => (
          <div key={p.id} className={`card ${p.id === "pro" ? "hl" : ""}`}>
            <div className="row"><h3>{p.name}</h3>{p.id === "pro" && <span className="badge acc">Most popular</span>}</div>
            <div className="price">{eur(p.monthlyFee)} <small>/ month</small></div>
            <ul className="clean">{p.features.map(f => <li key={f}>{f}</li>)}</ul>
            <Link href={`/signup?plan=${p.id}`} className={`btn ${p.id === "pro" ? "primary" : ""}`} style={{ width: "100%" }}>Choose {p.name}</Link>
          </div>
        ))}
        <div className="card ent">
          <div className="row"><h3>Enterprise</h3><span className="badge">Annual</span></div>
          <div className="price" style={{ fontSize: 26 }}>Custom</div>
          <ul className="clean">
            <li>Annual spend commitment (from {eur(12_000)})</li>
            <li>Negotiated per-metric prices</li>
            <li>Monthly invoice, net 30</li>
            <li>Dedicated support and SLA</li>
          </ul>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
            Example: {eur(ENTERPRISE_EXAMPLE.commitAmountEur)}/year · {ENTERPRISE_EXAMPLE.rateOverrides.map(o => perUnit(o.metric, o.priceEur)).join(" · ")}
          </p>
          <Link href="/enterprise" className="btn" style={{ width: "100%" }}>Contact sales</Link>
        </div>
      </div>
      <div className="grid g2 sec">
        <div className="card">
          <h3>Usage pricing</h3>
          <table><tbody>{Object.values(METRICS).map(m => <tr key={m.name}><td>{m.name}</td><td style={{ textAlign: "right" }}>{m.display}</td></tr>)}</tbody></table>
          <p className="muted" style={{ fontSize: 13 }}>Pro gets 10% off and Scale 20% off these prices. On Scale, if your overage reaches {eur(SPEND_THRESHOLD.scaleThreshold)} in a month, we charge it early.</p>
        </div>
        <div className="card">
          <h3>Balance bundles</h3>
          <table><tbody>{Object.values(BUNDLES).map(b => <tr key={b.id}><td>Pay {eur(b.price)}</td><td style={{ textAlign: "right" }}>Get <b>{eur(b.credit)}</b> <span className="badge ok">+{eur(b.credit - b.price)}</span></td></tr>)}</tbody></table>
          <p className="muted" style={{ fontSize: 13 }}>Valid for 12 months and kept if you change plans. On Pro and Scale you can turn on auto-recharge: we top your balance up to {eur(AUTO_RECHARGE.rechargeTo)} whenever it drops below {eur(AUTO_RECHARGE.threshold)}.</p>
        </div>
      </div>
    </>
  );
}
