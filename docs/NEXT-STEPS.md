# Wasabi — Next Steps

> Living roadmap (not a frozen snapshot). Current status: 🟢 **built + live** at [`wasabi.sanjow-hub.com`](https://wasabi.sanjow-hub.com) (Vercel + Neon, admin behind Google SSO — Auth.js, `@sanjow.com`). See [`ONE-PAGER.md`](./ONE-PAGER.md) for the management case and [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the built system.

_Last updated: 2026-06-29 · live at commit `51c1251e` (CTO handover doc · `/handover.html`)._

---

## 1 · Ship the VWO retirement — the actual goal

The platform is live; these unblock real traffic and the €6k/yr saving. Tracked here so they don't fall off the radar — most live in **other repos or external systems** and ship as their own tickets, per the in-repo scope rule.

- [ ] **Move the repo to the org** — `GambitIsHere/wasabi` → `Sanjow-Ventures/wasabi`. ⤴ GitHub admin action
  - Create empty `Sanjow-Ventures/wasabi`, `git remote set-url origin git@github.com:Sanjow-Ventures/wasabi.git`, push `develop` + `main`, repoint the Vercel project's git connection, archive the personal repo. After: scrub `GambitIsHere/wasabi` references from README / INTEGRATE-N8N-VPS / ONE-PAGER (3 places).
- [ ] **Wire the first storefront (TU)** — first real traffic. ⤴ cross-repo: lives in `prepaid-mobile-recharge-ai`
  - Drop `integration/storefronts/tu-prepaid-mobile-recharge-ai.middleware.ts` into the storefront as `middleware.ts`, set `WASABI_URL=https://wasabi.sanjow-hub.com` in its Vercel env, deploy a preview, verify the 307→`?theme=`→cookie sticky cycle in incognito, then flip the TU VWO campaign off. Acceptance: `tu-billing-uk` LiveResults verdict starts populating from real users.
- [ ] **Roll across the rest** — AC (`checkin-ai`) · AS (`fast-track-ai`, with the `?product=` + `?theme=` middleware variant) · PDF (`pdf-ai`). Each is its own cross-repo task. Templates already in `integration/storefronts/`.

## 2 · Platform depth — what Wasabi measures that VWO can't

The biggest *"why we built this"* upgrade. All in-repo, no cross-repo dependency.

- [ ] **Phase 1b — churn / trial→paid / LTV-by-cycle.** Extend `decision-helper/verdict.ts` + `dashboard/lib/metabase.ts` with three new arm-level metrics read from the `Subscription` model:
  - Trial→paid conversion %
  - 30d / 60d / 90d churn rate
  - LTV by billing cycle (cumulative net revenue per acquired customer)
  - Add to the `/experiments/[key]` LiveResults panel below the current funnel + net-rev block. Pure Metabase reads — no schema change.
- [ ] **Phase 3 — true ROAS / CAC via a Google-Sheets cost feed.** No Ads API.
  - New env: `GADS_COST_CSV_URL` (a published-CSV from an Ads cost export sheet).
  - Server-only fetch, join cost rows on theme/campaign, expose two metrics per arm: **ROAS** (= paid revenue / spend) and **true CAC** (= spend / acquired customer). Break-even CAC already ships; this completes the loop.
- [ ] **Phase 4 — Fireflies → backlog.** Mine call transcripts for test ideas; surface as `/backlog` candidates and optionally raise YouTrack tickets via the API. Needs a tiny NLP pass (keyword + intent) and the Fireflies API key already in Vercel env (rotate first — see §4).
- [ ] **Persist ticket↔experiment link.** Add `youtrack_id` + `youtrack_url` columns on `experiment`, surface as a picker in the create form (autocomplete from `/backlog`), badge on the card + detail page linking back to the ticket. Dedup: warn *"an experiment already exists for ticket GP-X"* when creating from a backlog item.

## 3 · YouTrack-driven backlog — in flight

Make `/backlog` a clean source instead of the keyword heuristic it runs on today.

- [ ] **Backfill the `experiment` tag** onto the curated **41-ticket** front-end-A/B set (genuine theme/flow/pricing tests; excludes ~19 VWO-tooling, ~7 payment/SCA, ~2 non-tests). ⤴ YouTrack admin · keep-list is regenerable from the curated query.
- [ ] **Create the shared saved search** *"Experiments (Wasabi)"* = `tag: experiment`. ⤴ YouTrack admin
- [ ] **Flip the backlog source** — set `YOUTRACK_BACKLOG_QUERY="tag: experiment"` in Vercel env (non-secret) + redeploy. The `/backlog` page already supports this — see the `NotConfigured`/heuristic-mode fallback at the page footer.

## 4 · Polish + housekeeping

- [ ] **Set Vercel Production Branch = `develop`** (Settings → Git) so pushes auto-deploy to prod — removes the manual `vercel --prod` step and the dangling-alias 404 risk. ⤴ Vercel dashboard
- [ ] **Rotate the Fireflies API key** — pasted in chat earlier; treat as burned. Keep the new key in Vercel env only.
- [ ] **Rotate the Google OAuth Client Secret + AUTH_SECRET** — both were pasted/generated in chat. Google Cloud Console → Credentials → *Wasabi Dashboard* → RESET SECRET. AUTH_SECRET: `openssl rand -base64 32` + `vercel env rm/add`. Rotating AUTH_SECRET invalidates active sessions (low cost — the admin set is small).
- [ ] **`/api/capture` rate-limit + a real sink.** Currently unauthenticated and unbounded — fine as a write-only stub, dangerous if anyone starts believing the logs. Code comment in `dashboard/lib/engine/handlers.ts:70-83` flags this. Before any external mention: add IP/distinctId rate limit + a Neon insert (or PostHog forward).
- [ ] **Branded 401 page** for the SSO redirect cold-state (currently plain text *"Authentication required"*). Cheap polish for the management-share first impression.
- [ ] **Demo script** for the management preview share — a 4-step *"open this URL → click that → look here → notice this verdict"* walk-through that lands the value in 60 seconds.
- [ ] **`METABASE_URL` + `METABASE_API_KEY`** are already set in Vercel env (verified 2026-06-25). Confirm the LiveResults panel actually renders on `/experiments/tu-billing-uk` — the only experiment with real Metabase data flowing.

---

## Recently done (since 2026-06-22 → 2026-06-29)

- ✅ **Google SSO via Auth.js v5** (`@sanjow.com` domain allowlist, branded sign-in page) — replaced basic-auth (`a93f5248`).
- ✅ **`description` field on experiments** — schema + DB migration + form textarea + card / detail render. Auto-fallback summary for empty descriptions preserved.
- ✅ **Canonical 6-seed set with management-grade descriptions** — 3 sample (TU billing UK, TU reward page, AC quarterly €79 vs biweekly €24.90) + 3 upcoming (AS fast-track £19 vs £14, PDF auth £49 vs £19, GT booking fee €0 vs €4.99) (`9f6a8edb`).
- ✅ **`/admin/reseed`** — in-app destructive reseed page (auth-gated, "type RESEED to arm"), POST `/api/admin/reseed` endpoint, shared logic in `lib/admin-reseed.ts`. Solves the Vercel-Neon-integration-locked-`DATABASE_URL` problem so we never have to copy connection strings out of the Neon Console (`6a76abe0`).
- ✅ **Per-ticket → create-experiment prefill** — `/backlog` "+ Test" link carries business + name + theme slug into `/experiments/new` (`5ec74355`).
- ✅ **System dark/light theme** — auto-follows OS preference; Optimiser.Pro tokens flip via CSS variables (`d1ca9934`).
- ✅ **Public CTO handover doc at `/handover.html`** — install + rollout guide, ungated (`51c1251e`).
- ✅ **Docs realigned with reality** — README ("spike → built + live"), ONE-PAGER ("what's left"), ARCHITECTURE (rewrite for the built system + superseded original P0 design appendix), PROPOSAL (dated pivot postscript), INTEGRATE-N8N-VPS (alternative-path banner), `.env.example` (full env reference).
- ✅ **Optimiser.Pro design system** — bold editorial tech across the dashboard (`4bebab68`).
- ✅ **YouTrack read plumbing** — `/backlog` + `/api/tickets`, business-mapped, admin-gated (`e20359b4`).
- ✅ **Live on Vercel + Neon** — public `/api/decide` + `/api/capture` for storefronts, everything else behind Google SSO.

---

## Conventions used in this doc

- **Checkbox** = todo item. Tick when shipped + add to *Recently done* with the commit SHA.
- **⤴ cross-repo / admin action** = work that's NOT in this repo (storefront edits, YouTrack admin, Vercel dashboard). Listed here as the canonical roadmap reference, but the actual edits land elsewhere — per the in-repo-only scope rule.
- Item order inside a section ≈ priority. Section order = bucket-level priority (Ship > Depth > Backlog plumbing > Polish).
