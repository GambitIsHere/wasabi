# Wasabi — Sanjow's in-house experimentation platform

> **Goal:** run our own A/B and Split-URL tests across every Sanjow storefront, fully in-house, and tie each test to its **real payment P&L** (auth rate, rebill rate, LTV) — replacing VWO (~€6k/yr) with zero per-seat SaaS spend.

This repo started as a fork of [Intuit's open-source Wasabi](README.intuit-original.md) (a Java A/B platform, **archived since 2019**) — we keep that code as historical reference only and **do not run it.** What we run is a lean, in-house, **PostHog-compatible** assignment engine + a Next.js admin dashboard + a Metabase-backed decision-helper. See `docs/ARCHITECTURE.md`.

## Why build this
- 💸 **Kill the VWO bill** (~€500/mo ≈ €6k/yr) — own it instead of renting it.
- 🔗 **Test ↔ P&L in one place.** We already tie variants to transactions via the `Theme` model (proven: we read the live £19-vs-£39 TU billing test straight from Metabase). VWO can't see auth/rebill/LTV; we can.
- 🧠 **A decision helper, not just a conversion %** — "variant X wins on 90-day LTV *and* cuts failed-rebill volume," not just "X converts the thank-you page better."

## Architecture (one line)
**A storage-free SHA-1 hash** decides each visitor's variant (PostHog-wire-compatible: same `(experimentKey, distinctId)` → same arm on any machine, no DB lookup) → maps to our existing **`?theme=` mechanism** → the storefront's theme-resolver picks the product/billing variant server-side (**unchanged**) → `themeId` flows to `Application`→`Transaction` → **Metabase + the decision-helper** read the real P&L per variant. See `docs/ARCHITECTURE.md`.

## Layout
| Path | What |
|---|---|
| `docs/` | `ONE-PAGER.md` (decision memo) · `PROPOSAL.md` (June 2026 management case + pivot postscript) · `ARCHITECTURE.md` (built system) |
| `engine/` | PostHog-compatible assignment engine — hash → bucket → variant, plus `/decide`, `/capture`, `/flags` HTTP, an SDK and a CLI |
| `dashboard/` | Next.js admin UI + the live `/api/*` routes + Neon-backed experiment store + Metabase-backed live results + YouTrack-backed test backlog |
| `decision-helper/` | the verdict layer — Metabase models + a two-proportion significance test → ship / keep-running call |
| `integration/` | drop-in storefront middleware templates (TU/AC/AS/PDF) + the rollout guide |
| `deploy/` | self-host runbook (Docker + Caddy) — **alternative**; canonical deploy is Vercel + Neon |
| `reference/` *(the Intuit Java)* | original Wasabi — reference only, not run |

## Status
🟢 **Built and live** at [`wasabi.sanjow-hub.com`](https://wasabi.sanjow-hub.com) (Vercel + Neon, admin behind basic-auth, `/api/decide`+`/api/capture` public for storefronts). What's left: (1) move the repo from `GambitIsHere/wasabi` → `Sanjow-Ventures/wasabi`, (2) wire the first storefront's middleware → first real traffic. See `docs/ONE-PAGER.md`.
