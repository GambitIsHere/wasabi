# Wasabi — Sanjow's in-house experimentation platform

> **Goal:** run our own A/B and Split-URL tests across every Sanjow storefront, fully in-house, and tie each test to its **real payment P&L** (auth rate, rebill rate, LTV) — replacing VWO (~€6k/yr) and consolidating MS Clarity, with **zero per-seat SaaS spend**.

This repo started as a fork of [Intuit's open-source Wasabi](README.intuit-original.md) (a Java A/B platform, **archived since 2019**). We keep that code as historical reference only — **our platform does not run it.** Instead we self-host modern open-source ([PostHog](https://posthog.com)) and add the Sanjow-specific glue + the decision layer that turns an experiment into a business call.

## Why build this
- 💸 **Kill the VWO bill** (~€500/mo ≈ €6k/yr) — own it instead of renting it.
- 🔗 **Test ↔ P&L in one place.** We already tie variants to transactions via the `Theme` model (proven: we read the live £19-vs-£39 TU billing test straight from Metabase). VWO can't see auth/rebill/LTV; we can.
- 👁️ **Consolidate.** PostHog also does session recording + heatmaps → can replace MS Clarity (coverage is currently poor) in the same move.
- 🧠 **Deeper insights + a decision helper** — "variant X wins on 90-day LTV *and* cuts failed-rebill volume," not just "X converts the thank-you page better."

## Architecture (one line)
**PostHog (self-hosted)** decides the variant → maps to our existing **`?theme=` mechanism** → the storefront resolves the product/billing variant server-side (already does this) → `themeId` flows to `Application`→`Transaction` → **Metabase + the decision-helper** read the real P&L per variant. See `docs/ARCHITECTURE.md`.

## Layout
| Path | What |
|---|---|
| `docs/` | `PROPOSAL.md` (management case) · `ARCHITECTURE.md` (how it works + phases) |
| `deploy/` | self-host PostHog (VPS) — compose/deploy notes + env |
| `integration/` | the glue: PostHog assignment ↔ `?theme=` ↔ payment-event stream |
| `decision-helper/` | the Metabase/analysis layer that turns variant economics into a recommendation |
| `reference/` *(the Intuit Java)* | original Wasabi — reference only, not run |

## Status
🟡 **Proposal / spike.** Built locally in `GambitIsHere/wasabi`; moves to `Sanjow-Ventures/wasabi` once management approves. Nothing here is in production yet.
