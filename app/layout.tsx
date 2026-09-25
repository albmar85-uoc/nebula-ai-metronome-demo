import "./globals.css";
import Nav from "@/components/Nav";

export const metadata = { title: "Nebula AI · Demo de facturación por uso", description: "Demo de planes por uso con Metronome y Stripe" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <Nav />
        {children}
        <div className="foot">Demo · Todas las cifras son de ejemplo · Facturación con Metronome + Stripe</div>
      </body>
    </html>
  );
}
