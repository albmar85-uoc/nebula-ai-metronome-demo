import "./globals.css";
import Nav from "@/components/Nav";
import Toaster from "@/components/Toaster";
import DemoControls from "@/components/DemoControls";
import Tour from "@/components/Tour";

export const metadata = { title: "Nebula AI · Usage-based billing demo", description: "Usage-based plans demo with Metronome and Stripe" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#content" className="skip">Skip to content</a>
        <Nav />
        <div id="content" tabIndex={-1}>{children}</div>
        <div className="foot" role="contentinfo">Demo · All figures are examples · Billing by Metronome + Stripe</div>
        <Toaster />
        <Tour />
        <DemoControls />
      </body>
    </html>
  );
}
