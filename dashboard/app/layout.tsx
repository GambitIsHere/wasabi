import type { Metadata } from "next";
import Link from "next/link";
import { JetBrains_Mono } from "next/font/google";
import { SiteNav } from "@/components/SiteNav";
import { UnknownWorkspace } from "@/components/UnknownWorkspace";
import { auth } from "@/auth";
import { roleAtLeast } from "@/lib/roles";
import { resolveTenantOrgId } from "@/lib/tenant";
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
  title: "Optimiser.Pro — in-house experimentation",
  description:
    "Optimiser.Pro is Sanjow's in-house, PostHog-compatible experimentation engine: sticky variant assignment plus a payment-P&L verdict on every test.",
};

// Runs synchronously in <head> before first paint: reads the persisted theme
// choice and forces data-theme for an explicit light/dark pick. A "system" or
// missing value sets nothing, so the CSS prefers-color-scheme query resolves the
// theme — this is the device-preference default. Prevents a light/dark flash.
const THEME_INIT = `(function(){try{var t=localStorage.getItem("wasabi-theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The ONE gate for requirement 1's "unknown subdomain must never silently
  // fall back to Sanjow": every page in the app renders through this layout,
  // so checking here — instead of in every individual page — is what makes
  // "forgot to check" structurally impossible rather than a convention to
  // remember. Route Handlers (app/api/**/route.ts) are NOT affected (they
  // don't render through the React tree at all), which is correct: /api/decide
  // and /api/capture use their own api_key-based resolution, unrelated to
  // subdomains (see lib/tenant.ts's header comment).
  //
  // Resolves via lib/tenant.ts's resolveTenantOrgId(): an authenticated
  // session's org always wins (renders children regardless of host — see
  // that file's header comment on the resolution order), so this only ever
  // actually shows UnknownWorkspace for an UNAUTHENTICATED request to a host
  // that doesn't resolve to a real org — chiefly /signin and /register on a
  // bad subdomain, since every gated route already requires a session via
  // middleware.ts before reaching here.
  const tenant = await resolveTenantOrgId();

  // Show the Settings nav entry only to an org admin/owner. Read from the JWT
  // claim (cheap, no DB round-trip) — the /settings page and its actions
  // re-authorize against the DB, so this is a UX decision, not a gate. A
  // pre-migration session with no `role` claim simply won't see the link.
  const session = await auth();
  const canManageOrg = Boolean(session?.role && roleAtLeast(session.role, "admin"));

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
                Optimiser<span className="text-accent">.Pro</span>
              </span>
              <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-accent sm:inline">
                Experimentation
              </span>
            </Link>
            {/* No nav for an unresolved tenant — every link would lead right
                back to this same "unknown workspace" state. */}
            {tenant && <SiteNav canManage={canManageOrg} />}
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-10">
          {tenant ? children : <UnknownWorkspace />}
        </main>
        <footer className="mx-auto flex max-w-6xl flex-wrap items-baseline justify-between gap-4 px-5 pb-12 pt-6 font-mono text-[11px] text-muted">
          <span>
            PostHog-compatible assignment · payment-P&amp;L verdicts
          </span>
          <span>
            Sanjow Ventures · <span className="text-accent">Optimiser.Pro</span>
          </span>
        </footer>
      </body>
    </html>
  );
}
