// ============================================================================
// Signal brand mark — the glowing neon dot. The ONE decorative pop in the
// Optimiser.Pro system, shared by the header wordmark and every standalone
// card (sign-in, register, invite, unknown workspace, not-found). Replaces the
// 🌶 chilli the tool carried from its Wasabi days; the marketing site and the
// membership portal never used it, so the tool now matches them.
// ============================================================================
const GLOW =
  "0 0 0 4px color-mix(in srgb, var(--color-neon) 18%, transparent), 0 0 14px color-mix(in srgb, var(--color-neon) 60%, transparent)";

export function BrandMark({
  size = "sm",
  className = "",
}: {
  /** "sm" sits inline with the wordmark; "lg" heads a standalone card. */
  size?: "sm" | "lg";
  className?: string;
}) {
  const dims = size === "lg" ? "size-3.5" : "size-2.5";
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full bg-neon ${dims} ${className}`.trim()}
      style={{ boxShadow: GLOW }}
    />
  );
}
