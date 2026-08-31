import Link from "next/link";
import { ImportVwoForm } from "@/components/ImportVwoForm";
import { countArchived } from "@/lib/archive";

// Auth-gated by middleware (path not in PUBLIC_PREFIXES). The prod Neon
// DATABASE_URL is locked to the runtime, so imports run in-app here rather than
// from a laptop script — same reason /admin/reseed exists.
export const dynamic = "force-dynamic";

export default async function ImportVwoPage() {
  const count = await countArchived().catch(() => 0);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <Link
          href="/archive"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-faint transition-colors hover:text-fg"
        >
          <span aria-hidden="true">←</span> Archive
        </Link>
        <p className="eyebrow">Admin · import</p>
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
          Import past <span className="serif-accent">experiments</span>
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Loads completed VWO / Wingify campaigns into the archive with their
          results attached — visitors, conversion rate, uplift and significance
          per arm. Upsert is keyed on the campaign slug, so re-running an import
          overwrites cleanly rather than duplicating. The archive currently holds{" "}
          <span className="font-mono text-fg">{count}</span>{" "}
          {count === 1 ? "experiment" : "experiments"}.
        </p>
      </section>

      <section className="rounded-xl border border-info/25 bg-info/5 p-5">
        <h2 className="font-display text-sm font-semibold text-info">
          Where the JSON comes from
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The import agent pulls each campaign from the Wingify MCP (or a browser
          pass over the VWO reports) and emits an array of experiments in the
          shape shown in the box below. Paste it here and import — nothing is
          sent anywhere except this database.
        </p>
      </section>

      <ImportVwoForm />
    </div>
  );
}
