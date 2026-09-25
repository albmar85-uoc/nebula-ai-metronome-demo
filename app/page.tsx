import Link from "next/link";
import Pricing from "@/components/Pricing";

export default function Home() {
  return (
    <main className="wrap">
      <section className="hero">
        <span className="badge acc">Generative AI API</span>
        <h1>Pay only for the tokens <span className="grad">you use</span></h1>
        <p>Text and images with a single API. Start free with €5 in credits every month, upgrade as you grow and top up your balance with bonus credit.</p>
        <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
          <Link href="/signup" className="btn primary">Create a free account</Link>
          <a href="/api/demo" className="btn">Try the demo account</a>
        </div>
      </section>
      <section id="pricing" className="sec" data-tour="pricing"><h2>Pricing</h2><Pricing /></section>
    </main>
  );
}
