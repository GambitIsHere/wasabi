"use client";

// Header navigation with active-route highlighting (mint underline). Client
// component so it can read the pathname; kept tiny so the rest of the layout
// stays server-rendered.
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Experiments" },
  { href: "/roadmap", label: "Roadmap" },
  { href: "/backlog", label: "Backlog" },
  { href: "/archive", label: "Archive" },
];

export function SiteNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1 text-sm">
      {LINKS.map((l) => {
        const active =
          l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`relative rounded-md px-3 py-1.5 transition-colors ${
              active ? "text-fg" : "text-muted hover:text-fg"
            }`}
          >
            {l.label}
            {active && (
              <span
                className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-accent"
                aria-hidden="true"
              />
            )}
          </Link>
        );
      })}
      <a
        href="/api/flags"
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-md px-3 py-1.5 font-mono text-xs text-faint transition-colors hover:text-accent"
        title="PostHog-compatible feature-flag payload — the public wire shape storefronts read"
      >
        /api/flags <span aria-hidden="true">↗</span>
        <span className="sr-only">(opens in new tab)</span>
      </a>
    </nav>
  );
}
