import type { Metadata } from "next";
import Link from "next/link";
import {
  Space_Grotesk,
  Inter,
  JetBrains_Mono,
  Instrument_Serif,
} from "next/font/google";
import { SiteNav } from "@/components/SiteNav";
import "./globals.css";

// Optimiser.Pro type system — Space Grotesk (display) × Inter (body) ×
// JetBrains Mono (data/labels) × Instrument Serif (editorial italic accent).
const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});
const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Wasabi — in-house experimentation",
  description:
    "Wasabi is Sanjow's in-house, PostHog-compatible experimentation engine: sticky variant assignment plus a payment-P&L verdict on every test.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable} ${serif.variable}`}
    >
      <body className="min-h-screen antialiased">
        {/* Signature aurora hairline. */}
        <div
          className="h-0.5 w-full"
          style={{ background: "var(--grad-aurora)" }}
          aria-hidden="true"
        />
        <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur-md">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
            <Link href="/" className="group flex items-center gap-3">
              <span className="font-display text-xl font-semibold tracking-tight text-fg transition-colors group-hover:text-accent">
                <span aria-hidden="true">🌶</span> Wasabi
              </span>
              <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-accent sm:inline">
                Experimentation
              </span>
            </Link>
            <SiteNav />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-10">{children}</main>
        <footer className="mx-auto flex max-w-6xl flex-wrap items-baseline justify-between gap-4 px-5 pb-12 pt-6 font-mono text-[11px] text-faint">
          <span>
            Wasabi · PostHog-compatible assignment · payment-P&amp;L verdicts
          </span>
          <span>
            Sanjow Ventures · <span className="text-accent">Optimiser.Pro</span>
          </span>
        </footer>
      </body>
    </html>
  );
}
