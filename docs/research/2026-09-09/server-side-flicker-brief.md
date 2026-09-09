# Server-side flicker: can Optimiser.Pro beat VWO, and is it sellable today

**Answer first.** The architecture wins the flicker argument. The deployment does not exist yet, and one number in it is wrong enough to invalidate experiments.

Three findings decide this:

1. The zero-flicker claim is **architecturally true and not yet demonstrable**. The Wasabi storefront middleware is a ready-to-apply reference file in this repo. It has never been copied into the storefront. Nothing in production assigns variants server-side today.
2. Assignment is **not edge-computed**. The middleware runs at the edge, but it calls `POST /api/decide`, a Node serverless route marked `force-dynamic`. That is an origin hop on the storefront's critical path.
3. The decide call is given **25 ms**. Cross-origin, to a serverless function that can cold-start and can miss its cache. Every expiry silently assigns control. That is not a flicker problem, it is a sample-ratio problem, and it is the most important thing in this brief.

"Zero flicker" is also not the moat it sounds like. GrowthBook ships edge-computed, HTML-baked assignment today, open source. The defensible claim is narrower and stated in part 4.

---

## 1. The incumbents — how each handles flicker, and what it costs them

### VWO — client-side by default, flicker paid for with a blank page

VWO's SmartCode hides the elements a test touches before they render, then reveals them once the variation has been swapped in. VWO's own material puts the average at 110 ms. The mechanism is the standard anti-flicker trade: prevent the flash of original content by showing nothing at all for a window.

The cost lands on Largest Contentful Paint. Hiding content means the visitor spends longer looking at an empty page, and LCP is a Core Web Vital. DebugBear's measured case — Adroll's homepage running Mutiny, the same body-hiding technique — showed LCP improving from **6 s to 2.7 s** when the hiding CSS was disabled. One case, not a benchmark, but it is a measured one and it is the right order of magnitude to quote.

VWO's own help centre documents the flicker as a known condition with causes and mitigations, which is the honest read: it is managed, not eliminated.

VWO's answer for teams that want it eliminated is **FullStack**, its server-side SDK product. It removes flicker by removing the client-side snippet. VWO positions FullStack as a complement to its visual client-side testing rather than a standalone platform, and it is generally rated less mature than Optimizely's equivalent.

### Optimizely — same split, more established server side

Optimizely Feature Experimentation runs server-side SDKs with no page flicker, and is the more established server-side offering of the two. Optimizely also sells Edge/Performance Edge for high-traffic sites specifically to reduce flicker, at higher cost and setup complexity.

### GrowthBook — the one that already does what we are claiming

This is the finding that should shape positioning. GrowthBook's Edge App runs on Cloudflare Workers as a proxy between the app and the user. It evaluates flags and Visual Editor experiments **before the HTML ships**, renders variants directly into the HTML served from the edge, and optionally injects the JS SDK with a hydrated payload so the front end continues without an extra network request. Their stated result is no flicker, no page-load delay, and no ad-blocker exposure.

So "server-side, no flicker" does not by itself differentiate us from an open-source competitor. It differentiates us from VWO's **default** product, which is what Sanjow actually runs against.

### The mechanism-and-cost table

| Approach | Mechanism | What it costs |
|---|---|---|
| VWO SmartCode (default) | Hide targeted elements, swap, reveal (~110 ms avg) | Blank window; LCP penalty; JS on critical path; ad-blocker exposure |
| Anti-flicker snippet generally | `opacity: 0` / hidden body until customisations apply | Measured LCP 6 s → 2.7 s when removed (Adroll/Mutiny) |
| VWO FullStack | Server-side SDK, no snippet | Engineering cost; less mature than Optimizely's |
| Optimizely Feature Experimentation | Server-side SDK | Engineering cost; established |
| Optimizely Edge | Assignment at edge | Higher cost, setup complexity |
| GrowthBook Edge App | Cloudflare Worker bakes variant into HTML, injects hydrated payload | Requires edge deploy; already solved and free |
| **Wasabi (as designed)** | Edge middleware, `?theme=` slug, variant page served inline | Origin hop for the decision; one 307 on first assignment |

---

## 2. Our current state — the real pipeline, not the theory

### The deployed storefront does no assignment at all

`proxy.ts` in `prepaid-mobile-recharge-ai` (253 lines) is the deployed edge middleware. It resolves host to brand, maps `?theme=` slugs to locales, and sets `NEXT_LOCALE` and checkout-currency cookies. It contains no experiment logic, no variant selection, and no call to Wasabi. Grepping the whole repo for `api/decide`, `getFeatureFlag` or `experiment_key` returns nothing.

What splits traffic today is **which ad URL Google Ads sends the visitor to**. `?theme=tu_lov_fr` arrives in the URL from the campaign. The storefront reads it and renders that theme server-side.

That has an interesting consequence worth being precise about: **we have zero flicker in production right now**, but not because of server-side assignment. There is no client-side mutation because there is no runtime assignment at all. It is a true statement about the site and a misleading one about the product.

### The intended pipeline, as written

`integration/storefronts/tu-prepaid-mobile-recharge-ai.middleware.ts` is marked READY TO APPLY and has not been applied.

- **Where the decision happens.** Next.js middleware runs at the edge, but line 40 issues `fetch(WASABI_URL + "/api/decide")`. `app/api/decide/route.ts` declares `runtime = "nodejs"` and `dynamic = "force-dynamic"` (lines 9-10). The decision is therefore an **origin round-trip from the edge**, not an edge computation. It adds to TTFB on every unassigned request.
- **What bounds it.** `DECIDE_TIMEOUT_MS = 25` (line 32), an `AbortController`, and a fail-safe returning `null`, which means control.
- **What makes it survivable.** `assignmentRegistry()` caches the experiment registry per serverless instance for `REGISTRY_TTL_MS = 10_000`, keyed by project (`lib/engine/handlers.ts:37-46`). A warm instance answers with zero DB round-trips.
- **Redirect or inline.** Both, by design. First assignment issues `NextResponse.redirect(target, 307)` to `?theme=<slug>` (line 84) because the storefront reads the theme client-side as well as server-side, so the slug has to land in the real URL. The slug is then remembered in a cookie and every later request is a **rewrite**, not a redirect (lines 76-77). One redirect per visitor per experiment.
- **Stickiness.** `wasabi_did` for a year, `wasabi_<experiment>` for 30 days (lines 28-31). Underneath, `getFeatureFlag` hashes deterministically on `distinctId`, so assignment is stable even if the cookie is lost.

### Where this genuinely beats VWO, and where it does not

**Beats it.** No snippet on the critical path. No hidden body. No DOM mutation after paint, so no flash of original content and no layout shift from the experiment. The variant is a different themed page rendered by the server, not a patched version of the control.

**Does not beat it.**

- **The decision is an origin hop.** GrowthBook computes at the edge. We fetch across the network to a Node function. On a cold instance with a registry miss, that is a DB read inside a 25 ms budget.
- **First load costs an extra round-trip.** A 307 is not FOOC — nothing is painted and then changed, so the flicker claim survives intact. But it is a full extra RTT before the first byte of real content, and it rewrites the visitor's URL. Against GrowthBook's inline HTML injection, we are one round-trip behind on first view.
- **The 25 ms budget is the serious one.** A cross-origin POST to a `force-dynamic` Node route will exceed 25 ms often, and on a cold start it will exceed it by an order of magnitude. Every expiry fails safe to control. Failing safe is right for the page and wrong for the experiment: it produces a silent, systematic over-assignment to control that grows with latency. That is a sample-ratio mismatch generated by our own timeout. The SRM check now on the results page would flag it, which is the good news, but the cause would sit in middleware, not in the stats.

---

## 3. Recommendations, ranked

Ranked by whether they close a real gap, not by elegance.

**R1 — Raise or restructure the 25 ms budget before anything ships.** Real gap, high severity, low effort. Either widen the budget to something a cross-origin serverless call can actually meet, or stop letting a timeout mean control. The cleanest fix is to make a timeout mean *not enrolled* rather than *control*: an unassigned visitor should be excluded from the experiment, not counted in its baseline. Without this, every other item here optimises a pipeline that is biased.

**R2 — Move assignment to the edge and delete the origin hop.** Real gap, medium-high effort. The hash is deterministic and the registry is small. Computing the variant in the middleware itself removes the network call, the timeout and the cold start together. This is the item that closes the distance to GrowthBook.

**R3 — Ship the integration to one storefront and measure it.** Real gap, low effort, highest evidential value. Nothing in this brief is provable to a prospect until one site runs it. Pair it with a before/after LCP and CLS capture so the claim has numbers attached.

**R4 — Remove the first-load redirect by serving the variant inline.** Real gap, medium effort. It exists because the storefront reads `?theme=` on the client. Passing the decision through a request header or a cookie the client can read at first paint would let the middleware rewrite instead of redirect on the very first request, saving a full RTT.

**R5 — Cache the decision at the edge per `distinctId`.** Partial gap, low effort once R2 lands. Largely moot if assignment becomes local.

**R6 — Publish a CLS and LCP comparison against a VWO-instrumented control page.** Not a gap, pure sales asset, low effort. This is what converts the argument into evidence.

### Candidate tickets — for sign-off, not created

Listed for Srikant to decide on. None of these has been created.

| # | Candidate | Repo | Ties to |
|---|---|---|---|
| C1 | Timeout must not mean control — treat an undecided visitor as not enrolled | wasabi | R1 |
| C2 | Compute assignment in edge middleware, drop the `/api/decide` hop | wasabi | R2 |
| C3 | Apply the Wasabi middleware to one storefront and capture before/after Web Vitals | prepaid-mobile-recharge-ai | R3 |
| C4 | Serve the assigned theme without the first-load 307 | both | R4 |
| C5 | Publish the LCP/CLS comparison page against a VWO-instrumented control | optimiser.pro | R6 |

---

## 4. Positioning

**The claim that survives scrutiny:**

> Your visitors never see the wrong page. Optimiser.Pro decides the variant on the server, before the first byte — so there is no anti-flicker snippet hiding your page, no flash of the original, and no layout shift from the test itself.

Note what it does not say. It does not claim to be the only tool that does this, because GrowthBook does it too and a technical buyer will know. It claims the thing VWO's **default product** cannot do without hiding the page.

**Proof points a prospect will actually check:**

1. View source on a running experiment. The variant is in the HTML. There is no experiment JavaScript to find.
2. No anti-flicker snippet anywhere in the page, so nothing sets the body to hidden or `opacity: 0`.
3. LCP and CLS measured on a variant page against the same page under VWO. Cite the DebugBear 6 s → 2.7 s case as the mechanism, then show our own numbers.
4. Disable JavaScript. The variant still renders, because the server chose it.
5. Ad blockers do not change assignment, because there is no third-party script to block.

**Do not claim yet:** that we are faster end-to-end than an edge-native competitor. Until R2 lands we carry an origin hop they do not, and on first view we carry a redirect they do not.

---

## Method and limits

- The VWO and Wingify MCP tools were not available in this session, so the VWO findings come from public documentation and VWO's own published material rather than from inspecting a live campaign or snippet. Worth re-running that section with those tools connected.
- Part 2 is read directly from the repositories and is the most reliable section here.
- The latency figures in part 2 are the configured budgets and cache TTLs as written in code. No timings were measured against a live deployment, because none exists to measure.
- The single LCP figure quoted is one vendor-published case, not an industry benchmark, and is labelled as such above.

## Sources

- [How VWO Affects your Site Speed](https://vwo.com/blog/how-vwo-affects-site-speed/)
- [Understanding VWO SmartCode](https://vwo.com/blog/understanding-vwo-smartcode/)
- [Why Do I Notice a Page Flicker When the VWO Test Page is Loading?](https://help.vwo.com/hc/en-us/articles/360020440754-Why-Do-I-Notice-a-Page-Flicker-When-the-VWO-Test-Page-is-Loading)
- [Anti-Flicker Snippets From A/B Testing Tools And Page Speed — DebugBear](https://www.debugbear.com/blog/ab-testing-anti-flicker-body-hiding)
- [Remove A/B test anti-flicker snippets when no tests are running — Shopify](https://shopify.dev/docs/storefronts/themes/best-practices/performance/disable-ab-testing-when-inactive)
- [Cloudflare Workers Edge App & SDK — GrowthBook Documentation](https://docs.growthbook.io/lib/edge/cloudflare)
- [GrowthBook Edge App for other edge providers](https://docs.growthbook.io/lib/edge/other)
- [Better visual editor experiments — GrowthBook](https://www.growthbook.io/blog/better-visual-editor-experiments)
- [VWO vs Optimizely vs GrowthBook: A/B Testing Tools Compared (2026)](https://productgrowth.in/tools/compare/vwo-vs-optimizely-vs-growthbook/)
- [Optimizely vs VWO vs Statsig (2026 Comparison)](https://www.artisangrowthstrategies.com/blog/optimizely-vwo-statsig-best-ab-testing-platform)
- [Manage flicker — Adobe Experience Platform](https://experienceleague.adobe.com/en/docs/experience-platform/edge/personalization/manage-flicker)
