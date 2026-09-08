// Shared refusal panel for the operator console. Rendered whenever
// requireSuperAdmin() denies — deliberately generic (never says WHICH check
// failed), and rendered INSTEAD of any cross-org data (the page fetches nothing
// on the deny path). Server-safe.
export function AccessDenied({ message }: { message: string }) {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <p className="eyebrow">Operator console</p>
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
          Sanjow <span className="serif-accent">operators</span> only
        </h1>
      </section>
      <div
        role="alert"
        className="rounded-xl border border-bad/30 bg-bad/5 px-5 py-6 text-sm text-bad"
      >
        {message}
      </div>
    </div>
  );
}
