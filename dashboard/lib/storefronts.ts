// ============================================================================
// Wasabi — business → production storefront map, for the create-form preview.
// ----------------------------------------------------------------------------
// PURE module (no I/O): the create/edit form's live-preview section reads this
// to build a `<storefront-url>?theme=<slug>` URL per arm so an author can SEE
// what each variant renders before the test runs. Kept here (not inline in the
// component) so the URL composition + framing decision are unit-testable and
// there is ONE place to add a business's storefront.
//
// Repo → business mapping comes from integration/storefronts/README.md
// (TU → prepaid-mobile-recharge-ai, AC → checkin-ai, AS → fast-track-ai,
// PDF → pdf-ai); the production origins below are each repo's live domain:
//   - Top Up            https://topup-mobile.co         (x-brand: topup-mobile)
//   - Airport Check-In  https://checkin.my-trip-online.com  (checkin-ai default brand)
//   - Airport Security  https://travel-synch.com        (fast-track-ai site URL)
//   - PDF SaaS          https://www.we-pdf.online        (pdf-ai public site)
//
// FRAMING: whether a storefront can be embedded in an <iframe> is governed by
// its X-Frame-Options / CSP `frame-ancestors` response headers. Checked live on
// 2026-09-07: all four storefronts send NEITHER header (and no meta-CSP), so
// all four frame. A storefront that later starts blocking framing should flip
// to `framing: "block"` here — the form then renders an "Open preview ↗" link
// instead of a dead grey iframe. The businesses with no entry (Global Tickets,
// Global Visa, Gift Cards, Airport Lounges) have no storefront wired yet and
// degrade to "no preview URL for this business".
// ============================================================================
import type { Business } from "./mgmt";

export interface StorefrontPreview {
  /** Production storefront origin — no trailing slash, no path, no query. */
  url: string;
  /**
   * Can this origin be embedded in an <iframe>? "allow" → the form shows a
   * live iframe; "block" → it shows only an open-in-new-tab link. Set from the
   * live X-Frame-Options / CSP frame-ancestors headers (see the file header).
   */
  framing: "allow" | "block";
}

/** Only businesses with a live storefront appear here; the rest resolve to null. */
export const STOREFRONTS: Partial<Record<Business, StorefrontPreview>> = {
  "Top Up": { url: "https://topup-mobile.co", framing: "allow" },
  "Airport Check-In": { url: "https://checkin.my-trip-online.com", framing: "allow" },
  "Airport Security": { url: "https://travel-synch.com", framing: "allow" },
  "PDF SaaS": { url: "https://www.we-pdf.online", framing: "allow" },
};

/** The storefront for a business, or null when none is wired. Accepts a plain
 *  string (the form's business value) rather than the Business union so a
 *  stale/hand-edited value fails safe to null instead of a type error. */
export function storefrontFor(business: string): StorefrontPreview | null {
  return STOREFRONTS[business as Business] ?? null;
}

/**
 * The preview URL for one arm: the storefront origin with `?theme=<slug>`
 * appended. Returns null when the business has no storefront or the slug is
 * blank — the caller then renders "no preview URL for this business" rather
 * than a broken frame. The storefront's own theme-resolver reads `?theme=`;
 * a slug it doesn't know simply serves the default theme (fail-safe, same
 * contract as the assignment middleware).
 */
export function previewUrlFor(business: string, themeSlug: string): string | null {
  const sf = storefrontFor(business);
  const slug = (themeSlug ?? "").trim();
  if (!sf || slug.length === 0) return null;
  return `${sf.url}?theme=${encodeURIComponent(slug)}`;
}
