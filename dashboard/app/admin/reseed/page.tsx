import Link from "next/link";
import { ReseedButton } from "@/components/ReseedButton";
import { SEED, SEED_PAUSED } from "@/lib/seeds";

// Auth-gated by middleware (path not in PUBLIC_PREFIXES). Listing the seed
// definitions is harmless reflection of the in-repo source of truth.
export const dynamic = "force-dynamic";

export default function ReseedPage() {
  const seedSummary = SEED.map((s) => ({
    key: s.key ?? "(no-key)",
    name: s.name,
    business: s.business,
    active: !SEED_PAUSED.has(s.key ?? ""),
    variants: s.variants.length,
  }));

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-faint transition-colors hover:text-fg"
        >
          <span aria-hidden="true">←</span> All experiments
        </Link>
        <p className="eyebrow">Admin · destructive</p>
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
          Reseed live <span className="serif-accent">DB</span>
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Wipes the <code className="font-mono text-xs text-accent/90">experiment</code> and{" "}
          <code className="font-mono text-xs text-accent/90">variant</code> tables in the live Neon
          database and re-applies the canonical{" "}
          <code className="font-mono text-xs text-accent/90">lib/seeds.ts</code> set. Use when the
          in-repo SEED has been updated and you want the change reflected in production. Anything
          you created via the admin UI will be lost — only the seeds end up in the DB.
        </p>
      </section>

      <section className="rounded-xl border border-bad/30 bg-bad/5 p-5">
        <h2 className="flex items-center gap-2 font-display text-sm font-semibold text-bad">
          <span aria-hidden="true">⚠</span> What this will do
        </h2>
        <ul className="mt-3 space-y-1.5 text-sm text-muted">
          <li>
            DELETE every row from <code className="font-mono text-xs text-fg">variant</code>.
          </li>
          <li>
            DELETE every row from <code className="font-mono text-xs text-fg">experiment</code>.
          </li>
          <li>
            INSERT the {SEED.length} seed experiments below ({SEED.length - SEED_PAUSED.size} active,{" "}
            {SEED_PAUSED.size} paused).
          </li>
          <li>
            Sticky cohort assignment is preserved for seeds whose variant keys are unchanged (e.g.{" "}
            <code className="font-mono text-xs text-fg">tu-billing-uk</code>): the SHA-1 hash is
            storage-free, so returning visitors land in the same arm. Renamed variant keys = fresh
            buckets.
          </li>
        </ul>
      </section>

      <section className="rounded-xl border border-line bg-surface">
        <header className="border-b border-line px-5 py-3">
          <h2 className="font-display text-sm font-semibold text-fg">
            Canonical seed set
          </h2>
          <p className="mt-0.5 text-xs text-faint">
            From <code className="font-mono">lib/seeds.ts</code>.
          </p>
        </header>
        <ul className="divide-y divide-line">
          {seedSummary.map((s) => (
            <li
              key={s.key}
              className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm"
            >
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                  s.active
                    ? "border-good/40 bg-good/10 text-good"
                    : "border-line-strong bg-bg text-faint"
                }`}
              >
                {s.active ? "active" : "paused"}
              </span>
              <code className="font-mono text-xs text-faint">{s.key}</code>
              <span className="text-fg">{s.name}</span>
              <span className="ml-auto text-xs text-faint">
                {s.business} · {s.variants} variants
              </span>
            </li>
          ))}
        </ul>
      </section>

      <ReseedButton />
    </div>
  );
}
