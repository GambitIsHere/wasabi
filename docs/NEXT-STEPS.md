# Wasabi — Next Steps

> Living roadmap (not a frozen snapshot). Current status: 🟢 **built + live** at [`wasabi.sanjow-hub.com`](https://wasabi.sanjow-hub.com) (Vercel + Neon). What's left, in priority order. See `ONE-PAGER.md` for the management case and `ARCHITECTURE.md` for the built system.

_Last updated: 2026-06-25 · live at commit `4bebab68` (Optimiser.Pro design system) + YouTrack read plumbing._

---

## 1 · Ship the VWO retirement — the actual goal
The platform is live; these two unblock real traffic and the cost saving.

- [ ] **Move the repo to the org** — `GambitIsHere/wasabi` → `Sanjow-Ventures/wasabi`. Repoint the Vercel git connection + local `origin` remotes afterward.
- [ ] **Wire the first storefront (TU)** — drop in the middleware from `integration/storefronts/` (TU reference ready), point it at `/api/decide`, turn the TU VWO campaign off → first real assignments → first live verdict.
- [ ] **Roll across the rest** (AC, AS, PDF, …) once TU is proven, then retire VWO.

## 2 · YouTrack-driven experiment backlog — in flight
Make `/backlog` a clean source and turn a ticket into an experiment in one click.

- [ ] **Backfill the `experiment` tag** onto the curated **41-ticket** front-end-A/B set (genuine theme/flow/pricing tests; excludes ~19 VWO-tooling, ~7 payment/SCA, ~2 non-tests). The exact keep-list is regenerable from the curated query and is ready to apply.
- [ ] **Create the shared saved search** *"Experiments (Wasabi)"* = `tag: experiment`.
- [ ] **Flip the backlog source** — set `YOUTRACK_BACKLOG_QUERY="tag: experiment"` in Vercel env (non-secret) + redeploy. The code already supports this — no code change, just the env var.
- [ ] **Per-ticket → create-experiment prefill** — the backlog "+ Test" link carries business + suggested name + theme slug into `/experiments/new`; the form pre-populates (validated against `BUSINESSES` / `THEME_SLUG_RE`). Designed; not yet built.

## 3 · Deeper P&L — phased
- [ ] **Phase 1b — churn / trial→paid / LTV-by-cycle** from the `Subscription` model.
- [ ] **Phase 3 — true ROAS / CAC** via a Google-Sheets published-CSV cost feed (`GADS_COST_CSV_URL`, no Ads API). Break-even CAC already ships.
- [ ] **Phase 4 — Fireflies → backlog** — mine call transcripts for test ideas into the backlog (optionally raising YouTrack tickets).

## 4 · Housekeeping
- [ ] **Set Vercel Production Branch = `develop`** (Settings → Git) so pushes auto-deploy to prod — removes the manual `vercel --prod` step (and the dangling-alias 404 risk).
- [ ] **Rotate the Fireflies API key** — it was pasted in chat; treat as burned. Keep it in Vercel env only.
- [ ] **`METABASE_URL` + `METABASE_API_KEY`** in Vercel env → unlocks the live per-variant P&L results panel.
- [ ] **Persist a ticket↔experiment link** (future) — store the YouTrack id/url on the experiment (schema change) → back-linking + dedup ("an experiment already exists for this ticket").

## Recently done
- ✅ **Optimiser.Pro design system** — bold editorial tech across the dashboard (`4bebab68`).
- ✅ **YouTrack read plumbing** — `/backlog` + `/api/tickets`, business-mapped, admin-gated (`e20359b4`).
- ✅ **Docs refreshed** — built→live, PostHog→lean pivot, Vercel/Neon canonical, full env reference.
- ✅ **Live on Vercel + Neon** — public `/api/decide`+`/api/capture`, admin behind basic-auth.
