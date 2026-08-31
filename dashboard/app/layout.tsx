import type { Metadata } from "next";
import Link from "next/link";
import { JetBrains_Mono } from "next/font/google";
import { SiteNav } from "@/components/SiteNav";
import "./globals.css";

// Cockpit type system — a native system-UI sans for everything readable (zero
// load, operator-tool feel; set as --font-sans in globals.css) and JetBrains
// Mono, the single webfont, for every key, slug, ID and tabular number.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Wasabi — in-house experimentation",
  description:
    "Wasabi is Sanjow's in-house, PostHog-compatible experimentation engine: sticky variant assignment plus a payment-P&L verdict on every test.",
};

// Runs synchronously in <head> before first paint: reads the persisted theme
// choice and forces data-theme for an explicit light/dark pick. A "system" or
// missing value sets nothing, so the CSS prefers-color-scheme query resolves the
// theme — this is the device-preference default. Prevents a light/dark flash.
const THEME_INIT = `(function(){try{var t=localStorage.getItem("wasabi-theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={mono.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-screen antialiased">
        {/* Flat hairline (Cockpit: no gradients). */}
        <div className="h-px w-full bg-line" aria-hidden="true" />
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
        <footer className="mx-auto flex max-w-6xl flex-wrap items-baseline justify-between gap-4 px-5 pb-12 pt-6 font-mono text-[11px] text-muted">
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
