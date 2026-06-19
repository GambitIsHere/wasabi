-- ============================================================================
-- Wasabi decision-helper — PER-EXPERIMENT RESULTS (variant P&L)
-- ----------------------------------------------------------------------------
-- Ties each experiment variant to its REAL payment outcomes. The variant's
-- identity is its theme slug; the P&L is the global-api "Transaction" table.
--
-- Runs READ-ONLY against the global-api Postgres (Metabase "MAIN DB - Production")
-- via sanjow-analytics/scripts/mb-query.sh. SELECT/CTE only — no mutations.
--
-- ATTRIBUTION PATH (see wasabi_variant.theme_slug === Theme.slug):
--     "Transaction" --applicationId--> "Application" --themeId--> "Theme".slug
-- Cohort-clean: we count an experiment's population by APPLICATIONS acquired on
-- or after the experiment start (Application."createdAt" >= <start>), so pre-test
-- traffic on the same theme never leaks in. Transactions are then attributed to
-- those applications regardless of when the payment cleared (a rebill can land
-- weeks later).
--
-- CONVENTIONS (sanjow-analytics): PascalCase tables + camelCase columns, all
-- double-quoted; money = "amountGBP". "type" vocabulary:
--   paid / failed / not_paid / auth_only / rebill / rebill_failed /
--   full_refund / partial_refund / open_chargeback / resolved_chargeback.
--
-- PER-VARIANT METRICS:
--   apps_acquired    distinct Applications in the cohort (the denominator)
--   first_paid       count of first-payment successes ("type"='paid')
--   auth_rate        paid / (paid + failed)          -- first-payment approval %
--   rebill_ok        renewal successes ("type"='rebill')
--   rebill_fail      renewal declines  ("type"='rebill_failed', attempt-level*)
--   rebill_rate      rebill / (rebill + rebill_failed) -- renewal collection %
--   revenue_gbp      SUM("amountGBP") over paid + rebill (cash collected)
--   rev_per_acquired revenue_gbp / apps_acquired      -- the £ verdict per arm
--
-- * rebill_failed is attempt-level and inflated by PSP retries (one failing
--   subscription can log several rows). Treat rebill_rate as a directional
--   collection signal, not an exact per-subscription rate. For a true rate,
--   dedupe by "subscriptionId" (see the optional variant at the bottom).
--
-- HOW TO USE FOR A NEW EXPERIMENT:
--   1. Replace the slug list in the WHERE clause with that experiment's
--      wasabi_variant.theme_slug values.
--   2. Replace the start TIMESTAMP with the experiment's started_at.
--   3. Run via:  bash sanjow-analytics/scripts/mb-query.sh - < this-block.sql
-- ============================================================================


-- ============================================================
-- GENERALIZED TEMPLATE  (edit the two ALL-CAPS placeholders)
-- ============================================================
WITH variant AS (
  -- The experiment cohort: applications acquired on/after the start date,
  -- on any of the experiment's variant theme slugs.
  SELECT
    th."slug"          AS theme_slug,
    a."applicationId"  AS application_id,
    a."createdAt"      AS app_created_at
  FROM "Application" a
  JOIN "Theme" th ON th."themeId" = a."themeId"
  WHERE th."slug" IN ( /* VARIANT_SLUGS */ 'slug_control', 'slug_b', 'slug_c' )
    AND a."createdAt" >= TIMESTAMP /* EXPERIMENT_START */ '2026-01-01'
),
tx AS (
  -- Every payment outcome belonging to a cohort application. LEFT JOIN keeps
  -- acquired-but-never-charged applications in apps_acquired.
  SELECT
    v.theme_slug,
    v.application_id,
    t."type"      AS tx_type,
    t."amountGBP" AS amount_gbp
  FROM variant v
  LEFT JOIN "Transaction" t ON t."applicationId" = v.application_id
)
SELECT
  theme_slug,
  COUNT(DISTINCT application_id)                                          AS apps_acquired,
  COUNT(*) FILTER (WHERE tx_type = 'paid')                               AS first_paid,
  ROUND(100.0 * COUNT(*) FILTER (WHERE tx_type = 'paid')
    / NULLIF(COUNT(*) FILTER (WHERE tx_type IN ('paid','failed')), 0), 1) AS auth_rate,
  COUNT(*) FILTER (WHERE tx_type = 'rebill')                             AS rebill_ok,
  COUNT(*) FILTER (WHERE tx_type = 'rebill_failed')                      AS rebill_fail,
  ROUND(100.0 * COUNT(*) FILTER (WHERE tx_type = 'rebill')
    / NULLIF(COUNT(*) FILTER (WHERE tx_type IN ('rebill','rebill_failed')), 0), 1) AS rebill_rate,
  ROUND(SUM(amount_gbp) FILTER (WHERE tx_type IN ('paid','rebill')), 2)  AS revenue_gbp,
  ROUND(SUM(amount_gbp) FILTER (WHERE tx_type IN ('paid','rebill'))
    / NULLIF(COUNT(DISTINCT application_id), 0), 2)                      AS rev_per_acquired
FROM tx
GROUP BY theme_slug
ORDER BY theme_slug;


-- ============================================================
-- WORKED EXAMPLE — experiment "tu-billing-uk" (Top Up billing test)
--   variants: tu_lov_uk (control) · tu_lov_uk_19 (£19) · tu_lov_uk_39 (£39)
--   start:    2026-05-07
-- Ready to run as-is:
--   bash sanjow-analytics/scripts/mb-query.sh - <<'SQL'  ...this block...  SQL
--
-- Live output (read-only DB, captured 2026-06-19) — sane per-variant P&L:
--   theme_slug    | apps  | first_paid | auth% | rebill_ok | rebill_fail | rebill% | revenue_gbp | rev/acq
--   --------------+-------+------------+-------+-----------+-------------+---------+-------------+--------
--   tu_lov_uk     | 23195 |       7361 |  54.6 |      2358 |        9799 |    19.4 |    196656.20 |   8.48  (control)
--   tu_lov_uk_19  |  3309 |       1030 |  52.4 |       520 |         710 |    42.3 |     21329.93 |   6.45  (£19)
--   tu_lov_uk_39  |  6408 |       2152 |  57.6 |      1069 |        3438 |    23.7 |     65782.70 |  10.27  (£39)
-- Read: £39 wins on rev_per_acquired (£10.27 vs control £8.48); £19 lifts the
-- rebill rate hard (42.3%) but its lower price caps £/acquired (£6.45).
-- ============================================================
WITH variant AS (
  SELECT
    th."slug"          AS theme_slug,
    a."applicationId"  AS application_id,
    a."createdAt"      AS app_created_at
  FROM "Application" a
  JOIN "Theme" th ON th."themeId" = a."themeId"
  WHERE th."slug" IN ('tu_lov_uk', 'tu_lov_uk_19', 'tu_lov_uk_39')
    AND a."createdAt" >= TIMESTAMP '2026-05-07'
),
tx AS (
  SELECT
    v.theme_slug,
    v.application_id,
    t."type"      AS tx_type,
    t."amountGBP" AS amount_gbp
  FROM variant v
  LEFT JOIN "Transaction" t ON t."applicationId" = v.application_id
)
SELECT
  theme_slug,
  COUNT(DISTINCT application_id)                                          AS apps_acquired,
  COUNT(*) FILTER (WHERE tx_type = 'paid')                               AS first_paid,
  ROUND(100.0 * COUNT(*) FILTER (WHERE tx_type = 'paid')
    / NULLIF(COUNT(*) FILTER (WHERE tx_type IN ('paid','failed')), 0), 1) AS auth_rate,
  COUNT(*) FILTER (WHERE tx_type = 'rebill')                             AS rebill_ok,
  COUNT(*) FILTER (WHERE tx_type = 'rebill_failed')                      AS rebill_fail,
  ROUND(100.0 * COUNT(*) FILTER (WHERE tx_type = 'rebill')
    / NULLIF(COUNT(*) FILTER (WHERE tx_type IN ('rebill','rebill_failed')), 0), 1) AS rebill_rate,
  ROUND(SUM(amount_gbp) FILTER (WHERE tx_type IN ('paid','rebill')), 2)  AS revenue_gbp,
  ROUND(SUM(amount_gbp) FILTER (WHERE tx_type IN ('paid','rebill'))
    / NULLIF(COUNT(DISTINCT application_id), 0), 2)                      AS rev_per_acquired
FROM tx
GROUP BY theme_slug
ORDER BY theme_slug;


-- ============================================================
-- OPTIONAL — true (deduped) rebill rate per variant
-- rebill_failed is attempt-level; dedupe by "subscriptionId" so retries on one
-- subscription count once. Gives a per-subscription collection rate.
-- (Standalone block; edit the same two placeholders as the template above.)
-- ============================================================
WITH variant AS (
  SELECT th."slug" AS theme_slug, a."applicationId" AS application_id
  FROM "Application" a
  JOIN "Theme" th ON th."themeId" = a."themeId"
  WHERE th."slug" IN ('tu_lov_uk', 'tu_lov_uk_19', 'tu_lov_uk_39')
    AND a."createdAt" >= TIMESTAMP '2026-05-07'
),
sub AS (
  -- one row per (variant, subscription): did it ever rebill ok / ever fail?
  SELECT
    v.theme_slug,
    t."subscriptionId"                                          AS subscription_id,
    BOOL_OR(t."type" = 'rebill')        AS ever_rebilled,
    BOOL_OR(t."type" = 'rebill_failed') AS ever_failed
  FROM variant v
  JOIN "Transaction" t ON t."applicationId" = v.application_id
  WHERE t."type" IN ('rebill', 'rebill_failed')
    AND t."subscriptionId" IS NOT NULL
  GROUP BY v.theme_slug, t."subscriptionId"
)
SELECT
  theme_slug,
  COUNT(*)                                                       AS subs_with_rebill_activity,
  COUNT(*) FILTER (WHERE ever_rebilled)                          AS subs_rebilled,
  ROUND(100.0 * COUNT(*) FILTER (WHERE ever_rebilled)
    / NULLIF(COUNT(*), 0), 1)                                    AS rebill_rate_deduped
FROM sub
GROUP BY theme_slug
ORDER BY theme_slug;
