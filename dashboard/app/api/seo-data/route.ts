// ============================================================================
// /api/seo-data — poll endpoint for the SEO dashboard's live revenue hero.
// ----------------------------------------------------------------------------
// Returns the modeled-revenue counter parameters synced from sanjow-analytics
// (seo/scripts/publish_wasabi.py). The /seo page's inline JS polls this every
// 60s so a fresh measurement deploy updates the number without a page refresh.
// SSO-gated (not in middleware PUBLIC_PREFIXES) — same-origin fetches from the
// signed-in /seo page carry the session cookie.
// ============================================================================
import { heroData, generatedAt } from "@/app/seo/dashboard-html";

export const dynamic = "force-static";

export function GET(): Response {
  return Response.json({ ...heroData, generatedAt });
}
