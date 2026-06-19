# Wasabi — bring A/B testing in-house (decision one-pager)

**For:** management · **From:** Product · **Status:** **built + working** · **Decision asked:** approve moving it to the org repo + a small VPS slot.

## The ask
Replace **VWO** with our own experimentation platform, **Wasabi** — already built this sprint and working end-to-end. Approve (1) moving it from the personal build repo to `Sanjow-Ventures/wasabi`, and (2) a small slot on the VPS we already run (n8n).

## Why it's worth it
- **Saves ~€6,000/year.** VWO is ~€500/mo. Wasabi runs on infra we already pay for — no licences, no per-seat cost.
- **Ties every test to real money.** VWO shows a thank-you-page conversion. Wasabi shows, per variant, **first-payment approval, rebill collection, revenue per customer, and statistical significance**, read straight from our payments DB. Proven on the live **£19-vs-£39 TopUp** test (£19 collects rebills at ~2× — a call VWO can't even see).
- **In-house and owned.** Our servers, our data, no third party.
- **Consolidation-ready.** The same platform can replace **MS Clarity** (session recording) as a follow-on — one tool, not three.

## It's not a slide — it's running
A full **create → activate → assign → verdict** loop, demonstrated in the browser:
- **Create/configure** experiments in a UI — variants, traffic split, `?theme=` routing, live validation.
- **Sticky, PostHog-compatible assignment** — storefronts call one endpoint (`/decide`); the existing theme system is untouched.
- **Live per-variant P&L verdict** — two-proportion significance test + a ship / keep-running / inconclusive call.
- **Persisted, self-hosted (SQLite), zero UI bugs.**

## What's left (small, days not months)
1. Move the repo to the org.
2. Deploy to a VPS slot — Docker, runbook already written (`deploy/`).
3. Wire **one** storefront's middleware and turn its VWO campaign off → first real traffic.

## Economics at a glance
| | VWO (today) | Wasabi (proposed) |
|---|---|---|
| Cost | ~€6,000 / yr | ~€0 (existing VPS) |
| Test ↔ revenue | not connected | **same database** |
| Data | VWO's servers | **ours** |
| Session recording | separate (Clarity) | folds in later |

## Decision
Approve the **org move + VPS slot**. We wire one storefront, prove it on real traffic, then roll off VWO across the board.

*Build repo: `GambitIsHere/wasabi` · runbook: `deploy/README.md` · architecture: `docs/ARCHITECTURE.md`.*
