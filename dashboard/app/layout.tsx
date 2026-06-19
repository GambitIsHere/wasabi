import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wasabi — in-house experimentation",
  description:
    "Wasabi is Sanjow's in-house, PostHog-compatible experimentation engine: sticky variant assignment plus a payment-P&L verdict on every test.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur-md">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
            <Link href="/" className="group flex items-baseline gap-2.5">
              <span className="text-xl font-semibold tracking-tight">
                <span aria-hidden="true">🌶</span>{" "}
                <span className="text-fg group-hover:text-accent transition-colors">
                  Wasabi
                </span>
              </span>
              <span className="hidden text-xs font-medium text-faint sm:inline">
                in-house experimentation
              </span>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link
                href="/"
                className="rounded-md px-3 py-1.5 text-muted transition-colors hover:bg-surface hover:text-fg"
              >
                Experiments
              </Link>
              <a
                href="/api/flags"
                className="rounded-md px-3 py-1.5 font-mono text-xs text-faint transition-colors hover:bg-surface hover:text-fg"
              >
                /api/flags
              </a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-5 pb-10 pt-4 text-xs text-faint">
          Wasabi · PostHog-compatible assignment · payment-P&amp;L verdicts ·
          Sanjow Ventures
        </footer>
      </body>
    </html>
  );
}
