// House loaders (Signal) — "bars" and "infinite", the two loaders that read as
// "measuring", not "stuck". Both are CSS/SVG only (no WebGL, no LCP tax) and
// inherit `color`, so they tint to the accent token by default and can be
// retinted with a text-* class. Used for inline in-progress states — an action
// running, results being fetched. Visual styling lives in globals.css
// (.spinner-bars / .spinner-infinite); reduced-motion collapses the animation
// via the global rule there. Server-safe (no client hooks).
type SpinnerProps = {
  /** "bars" (default) for inline/button waits; "infinite" for a roomier beat. */
  variant?: "bars" | "infinite";
  /** Extra classes — e.g. sizing. */
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
  if (variant === "infinite") {
    return (
      <span
        className={`spinner-infinite ${className}`.trim()}
        style={style}
        role="status"
        aria-label={label}
      >
        <svg width={44} height={26} viewBox="0 0 52 30" aria-hidden="true">
          <path className="track" d={INFINITE_PATH} />
          <path className="run" d={INFINITE_PATH} />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={`spinner-bars ${className}`.trim()}
      style={style}
      role="status"
      aria-label={label}
    >
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
