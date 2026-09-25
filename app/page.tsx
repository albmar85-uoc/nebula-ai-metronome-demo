import Link from "next/link";
import Pricing from "@/components/Pricing";

export default function Home() {
  return (
    <main className="wrap">
      <section className="hero">
        <span className="badge acc">API de IA generativa</span>
        <h1>Paga solo por los tokens <span className="grad">que usas</span></h1>
        <p>Texto e imágenes con una sola API. Empieza gratis con 5 € de créditos al mes, sube de plan cuando crezcas y recarga saldo con bonificación.</p>
        <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
          <Link href="/signup" className="btn primary">Crear cuenta gratis</Link>
          <a href="/api/demo" className="btn">Entrar con cuenta demo</a>
        </div>
      </section>
      <section id="precios" className="sec"><h2>Precios</h2><Pricing /></section>
    </main>
  );
}
