// Signal loaders — four variants, each carrying one meaning so a wait tells the
// operator what kind of wait it is:
//   bars      an action of YOURS is running (submit buttons, toggles)      — house
//   infinite  a verdict is being computed (results, Metabase reads)        — house
//   circle    a short in-row wait (assignment tester, a pill mid-toggle)
//   dots      waiting on something EXTERNAL (first capture, a webhook)
// All CSS/SVG (no WebGL, no LCP tax), inherit `color` so they tint to the accent
// by default and retint with a text-* class, and size with the font (1em) so they
// sit inside a button. Styling lives in globals.css (.spinner-*); the global
// reduced-motion rule collapses the animation. Server-safe (no client hooks).
// The same four variants ship in the marketing site and the membership portal.
type SpinnerVariant = "bars" | "infinite" | "circle" | "dots";

type SpinnerProps = {
  variant?: SpinnerVariant;
  /** Extra classes — e.g. sizing or retinting. */
  className?: string;
  /** Inline overrides — use `color` to retint (wins over the accent default). */
  style?: React.CSSProperties;
  /** Accessible label announced to assistive tech. */
  label?: string;
};

// One lemniscate path, shared by the track and the running dash.
const INFINITE_PATH =
  "M13 15 C13 6,26 6,26 15 C26 24,39 24,39 15 C39 6,26 6,26 15 C26 24,13 24,13 15 Z";

export function Spinner({
  variant = "bars",
  className = "",
  style,
  label = "Loading",
}: SpinnerProps) {
  const cls = `spinner-${variant} ${className}`.trim();
  if (variant === "infinite") {
    return (
      <span className={cls} style={style} role="status" aria-label={label}>
        <svg width={44} height={26} viewBox="0 0 52 30" aria-hidden="true">
          <path className="track" d={INFINITE_PATH} />
          <path className="run" d={INFINITE_PATH} />
        </svg>
      </span>
    );
  }
  if (variant === "circle") {
    return <span className={cls} style={style} role="status" aria-label={label} />;
  }
  if (variant === "dots") {
    return (
      <span className={cls} style={style} role="status" aria-label={label}>
        <i />
        <i />
        <i />
      </span>
    );
  }
  return (
    <span className={cls} style={style} role="status" aria-label={label}>
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export type { SpinnerVariant };
