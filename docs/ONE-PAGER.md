# Wasabi — bring A/B testing in-house (decision one-pager)

**For:** management · **From:** Product · **Status:** **built + live** at [`wasabi.sanjow-hub.com`](https://wasabi.sanjow-hub.com) · **Decision asked:** approve moving the repo to the org and wiring the first storefront.

## The ask
Replace **VWO** with our own experimentation platform, **Wasabi** — already built and live. Approve (1) moving it from the personal build repo to `Sanjow-Ventures/wasabi`, and (2) wiring the first storefront (TU) to start the VWO retirement.

## Why it's worth it
- **Saves ~€6,000/year.** VWO is ~€500/mo. Wasabi runs on Vercel's free tier + a free Neon DB — no licences, no per-seat cost.
- **Ties every test to real money.** VWO shows a thank-you-page conversion. Wasabi shows, per variant, **first-payment approval, rebill collection, revenue per customer, and statistical significance**, read straight from our payments DB. Proven on the live **£19-vs-£39 TopUp** test (£19 collects rebills at ~2× — a call VWO can't even see).
- **In-house and owned.** Our code, our DB, no third party owning the assignment.

## It's not a slide — it's running
A full **create → activate → assign → verdict** loop, live in the browser at [`wasabi.sanjow-hub.com`](https://wasabi.sanjow-hub.com):
- **Create/configure** experiments in a UI — variants, traffic split, `?theme=` routing, live validation.
- **Sticky, PostHog-compatible assignment** — storefronts call one endpoint (`/api/decide`); the existing theme system is untouched.
- **Live per-variant P&L verdict** — two-proportion significance test + a ship / keep-running / inconclusive call.
- **Persisted in Neon Postgres, deployed on Vercel, admin behind Google SSO (Auth.js, `@sanjow.com`).**

## What's left (small, days not months)
1. **Move the repo to the org** (`GambitIsHere/wasabi` → `Sanjow-Ventures/wasabi`).
2. **Wire one storefront's middleware** (TU first — template ready in `integration/storefronts/`) and turn its VWO campaign off → first real traffic.

## Economics at a glance
| | VWO (today) | Wasabi (live) |
|---|---|---|
| Cost | ~€6,000 / yr | **~€0** (Vercel + Neon free tiers) |
| Test ↔ revenue | not connected | **same database** |
| Data | VWO's servers | **ours** |
| Session recording | separate (Clarity) | not built — Clarity stays for now |

## Decision
Approve the **org move + first storefront wire-up**. We wire TU, prove it on real traffic, then roll across the remaining storefronts and retire VWO.

*Live: [`wasabi.sanjow-hub.com`](https://wasabi.sanjow-hub.com) · build repo: `GambitIsHere/wasabi` · runbook: `deploy/README.md` · architecture: `docs/ARCHITECTURE.md`.*
