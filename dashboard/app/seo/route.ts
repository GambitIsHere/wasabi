// ============================================================================
// /seo — the Sanjow SEO progression dashboard, served SSO-gated.
// ----------------------------------------------------------------------------
// The HTML is generated OUTSIDE this repo by the sanjow-analytics SEO
// measurement system (seo/scripts/build_dashboard.py) and synced in as the
// `dashboard-html.ts` module by seo/scripts/publish_wasabi.py. It updates on
// every weekly/monthly measurement run via a fresh commit — this route just
// serves the latest synced snapshot.
//
// Auth: NOT in middleware PUBLIC_PREFIXES, so the Google SSO gate
// (@sanjow.com) applies — safe to share the URL with the whole team.
// ============================================================================
import { html } from "./dashboard-html";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
