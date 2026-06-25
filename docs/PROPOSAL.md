# Proposal — bring experimentation in-house ("Wasabi")

**For:** management · **From:** Product · **Date:** 2026-06-17 · **Decision asked:** approve a spike + (if it proves out) a small VPS to self-host.

## The ask in one line
Stop renting VWO (~€500/mo) and run our own A/B / Split-URL testing in-house on self-hosted open-source, with every test tied to its real payment P&L.

## Why now
1. **Cost.** VWO is **~€6,000/year**. A self-hosted experimentation stack runs on one small VPS (~€40–80/mo). Net saving ~€5k/yr, and it scales with us at no extra per-seat cost.
2. **We already own the hard part.** Variants map to our `Theme` model and flow straight into `Application`→`Transaction`. We proved it this week: read the live **£19-vs-£39 TU billing test** directly from Metabase — auth rate, rebill rate, revenue per customer. **VWO only sees a thank-you-page conversion; we can see the actual money.**
3. **Consolidation.** The chosen tool (PostHog) also does **session recording + heatmaps**, so it can replace **MS Clarity** too (today only 3 of our storefronts have Clarity wired). One platform instead of VWO + Clarity.
4. **Better decisions.** A built-in "decision helper" frames the call in business terms — e.g. *"£19 collects rebills at 2× and cuts failed-rebill volume (helps the MID decline-ratio risk); £39 earns more per customer short-term — decide on 90-day LTV."* That's the kind of read VWO structurally can't give.

## What we're building
- **Self-hosted PostHog** (open-source, no licence cost) = variant assignment + experiment UI + stats + session recording.
- **Thin Sanjow glue** = PostHog's assignment → our existing `?theme=` mechanism (minimal storefront change), + a payment-event stream so experiments see checkout → paid → rebill → churn.
- **Decision helper** = Metabase models + a short narrative layer for the LTV / payment-health verdict.

## Cost & ownership
| | VWO (today) | Wasabi (proposed) |
|---|---|---|
| Spend | ~€500/mo SaaS | ~€40–80/mo VPS, no licences |
| Data | on VWO's servers | **our servers, our DB** |
| Test ↔ revenue | not connected | **same database** |
| Session recordings | separate (Clarity) | **included** |
| Per-seat cost | yes | none |

## Risk / honest caveats
- **Ops:** self-hosting PostHog (ClickHouse + Kafka) is a real, if modest, infra job — needs a ~16 GB VPS and some upkeep. We de-risk by **spiking it first** before committing.
- **Fallback:** if the ops proves heavier than it's worth, a **lean owned assignment service** (our code + Metabase) delivers the same P&L tie with a lighter stack — minus the session-recording consolidation.

## Plan
**Phase 0 (spike, ~days):** stand PostHog up on a VPS, wire the TU billing test as the first real experiment, pipe payment events, show £19-vs-£39 by auth/rebill/LTV inside the tool. **Go/no-go on the ops.**
**Phase 1:** one storefront fully on Wasabi (assignment + recordings + decision helper); retire its VWO campaigns.
**Phase 2:** roll across storefronts; turn off VWO; fold in Clarity replacement.

## Decision
Approve **Phase 0 spike** + a small VPS. No production traffic moves until the spike proves the ops and the insight depth.

---

## Postscript — what we actually built (June 2026 update)

During Phase 0 we **pivoted** away from self-hosted PostHog to the lean alternative this proposal explicitly mentions as the fallback ("a lean owned assignment service — our code + Metabase"). Concretely:

| | Originally proposed | What we built |
|---|---|---|
| **Assignment** | PostHog SDK | In-house engine — PostHog-wire-compatible SHA-1 hash, storage-free, served via `/api/decide` |
| **Store** | ClickHouse + Kafka | Neon Postgres (Vercel's managed offering) |
| **Hosting** | ~16 GB VPS, self-managed | Vercel free tier — no ops |
| **Admin UI + verdict** | (would have used PostHog's) | Custom Next.js dashboard + Metabase-backed two-proportion significance test |
| **Session recording** | PostHog (would replace Clarity) | **Not built** — Clarity stays separate for now |
| **Cost** | ~€40–80/mo VPS | **~€0** (Vercel + Neon free tiers) |

**Why the pivot:** the self-hosted PostHog stack (ClickHouse + Kafka, 16 GB memory floor) was real ops work for capabilities we didn't need on day one. The fallback delivers the same P&L tie with a fraction of the surface area; Clarity replacement can be a separate decision later. Net: better cost outcome, no ops burden, same insight depth.

**Live at:** [`wasabi.sanjow-hub.com`](https://wasabi.sanjow-hub.com) — admin behind basic-auth, `/api/decide` + `/api/capture` public for storefronts. See [`ONE-PAGER.md`](./ONE-PAGER.md) for the current decision ask and [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the built system.
