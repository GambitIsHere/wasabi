-- ============================================================================
-- Wasabi experiment-definition store — Postgres DDL
-- ----------------------------------------------------------------------------
-- Backs the TypeScript FeatureFlag / Variant types in engine/src/types.ts.
--
-- WHAT THIS STORE IS:  experiment + variant DEFINITIONS (the admin's source of
--   truth for "which experiments exist and how they split traffic"), plus two
--   purely OBSERVATIONAL tables (assignment audit + generic funnel events).
--
-- WHAT THIS STORE IS NOT:  the system of record for correctness or for money.
--   * Assignment is a DETERMINISTIC pure function of (experimentKey, distinctId)
--     — PostHog-compatible sha1 hash (see engine/src/hash.ts + assignment.ts).
--     Re-running it always yields the same variant, so wasabi_assignment is an
--     AUDIT trail only; the engine never reads it to decide a variant.
--   * Payment metrics (auth / rebill / refund / revenue) are NOT duplicated
--     here. They live in the global-api Postgres "Transaction" table and are
--     attributed to a variant via Theme.slug == wasabi_variant.theme_slug.
--     See decision-helper/results.sql for the per-variant P&L query.
--
-- CONVENTIONS:  this store is its OWN database (lowercase snake_case, the
--   Postgres default). It is deliberately separate from the global-api schema,
--   whose PascalCase "Transaction"/"Theme"/"Application" tables we only ever
--   READ from for results. The only cross-store contract is the slug string:
--   wasabi_variant.theme_slug  ===  global-api Theme.slug.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- wasabi_experiment  — one row per FeatureFlag (boolean flag OR experiment).
--   Maps to the TS `FeatureFlag` interface (engine/src/types.ts):
--     key                -> FeatureFlag.key
--     active             -> FeatureFlag.active
--     rollout_percentage -> FeatureFlag.rolloutPercentage  (0..100, share of
--                           users included in the flag at all; the rest get false)
--   Extra columns (business, goal_metric, started_at/ended_at) are admin/report
--   metadata that have no TS field — the engine's evaluation never needs them.
-- ----------------------------------------------------------------------------
CREATE TABLE wasabi_experiment (
  id                 BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key                TEXT          NOT NULL UNIQUE,
  name               TEXT          NOT NULL,
  active             BOOLEAN       NOT NULL DEFAULT FALSE,
  rollout_percentage NUMERIC(5,2)  NOT NULL DEFAULT 100
                       CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100),
  business           TEXT,
  goal_metric        TEXT,
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

COMMENT ON TABLE  wasabi_experiment IS
  'One FeatureFlag (boolean flag or multivariate experiment). Mirrors the TS FeatureFlag type in engine/src/types.ts. Definitions only — assignment is deterministic, never read back from this store.';
COMMENT ON COLUMN wasabi_experiment.key IS
  'FeatureFlag.key — stable experiment key, e.g. "tu-billing-uk". Unique; the SDK/decide contract addresses experiments by this.';
COMMENT ON COLUMN wasabi_experiment.name IS
  'Human-readable name for the admin UI. No TS equivalent.';
COMMENT ON COLUMN wasabi_experiment.active IS
  'FeatureFlag.active — when FALSE the flag is off entirely and every user evaluates to false.';
COMMENT ON COLUMN wasabi_experiment.rollout_percentage IS
  'FeatureFlag.rolloutPercentage — 0..100 share of users included in the flag at all (the rest get false). Distinct from per-variant splits in wasabi_variant.';
COMMENT ON COLUMN wasabi_experiment.business IS
  'Admin label for which storefront/business this experiment runs on (e.g. "Top Up"). A human label, NOT global-api Business.businessId (which is a UUID). Report metadata only.';
COMMENT ON COLUMN wasabi_experiment.goal_metric IS
  'The experiment goal (e.g. "rev_per_acquired", "rebill_rate"). An experiment = a multivariate flag + a goal metric. Report metadata only.';
COMMENT ON COLUMN wasabi_experiment.started_at IS 'When the experiment went live. Used as the cohort start for results (Application."createdAt" >= started_at).';
COMMENT ON COLUMN wasabi_experiment.ended_at   IS 'When the experiment was concluded; NULL while running.';

-- ----------------------------------------------------------------------------
-- wasabi_variant  — one row per arm of an experiment.
--   Maps to the TS `Variant` interface (engine/src/types.ts):
--     key                -> Variant.key                (e.g. "control", "variant_19")
--     rollout_percentage -> Variant.rolloutPercentage  (0..100, share of the
--                           IN-FLAG population assigned to this variant; arms
--                           across one experiment sum to 100)
--   theme_slug encodes the ThemeMap contract (TS `ThemeMap = Record<string,string>`):
--     it is the storefront "?theme=" slug a variant key resolves to, and it is
--     the JOIN KEY into global-api: wasabi_variant.theme_slug === Theme.slug.
-- ----------------------------------------------------------------------------
CREATE TABLE wasabi_variant (
  id                 BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  experiment_id      BIGINT        NOT NULL
                       REFERENCES wasabi_experiment(id) ON DELETE CASCADE,
  key                TEXT          NOT NULL,
  rollout_percentage NUMERIC(5,2)  NOT NULL
                       CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100),
  theme_slug         TEXT          NOT NULL,
  is_control         BOOLEAN       NOT NULL DEFAULT FALSE,
  UNIQUE (experiment_id, key)
);

CREATE INDEX idx_wasabi_variant_experiment ON wasabi_variant (experiment_id);
-- theme_slug is the cross-store join key into global-api Theme.slug; index it so
-- "all variants for these slugs" lookups (results attribution) stay cheap.
CREATE INDEX idx_wasabi_variant_theme_slug ON wasabi_variant (theme_slug);

COMMENT ON TABLE  wasabi_variant IS
  'One arm of an experiment. Mirrors the TS Variant type in engine/src/types.ts. theme_slug is the ThemeMap value (Variant.key -> "?theme=" slug) and the join key into global-api Theme.slug.';
COMMENT ON COLUMN wasabi_variant.experiment_id IS 'FK -> wasabi_experiment.id. Variants belong to exactly one experiment (the TS FeatureFlag.variants[] array).';
COMMENT ON COLUMN wasabi_variant.key IS
  'Variant.key — stable arm key returned as the flag value, e.g. "control" | "variant_19". Unique within its experiment.';
COMMENT ON COLUMN wasabi_variant.rollout_percentage IS
  'Variant.rolloutPercentage — 0..100 share of the IN-FLAG population assigned to this arm. Arms within one experiment should sum to 100.';
COMMENT ON COLUMN wasabi_variant.theme_slug IS
  'The storefront "?theme=" slug this variant resolves to (the ThemeMap contract). EXACTLY EQUALS global-api Theme.slug — the join key that ties a variant to its real Transaction P&L (see decision-helper/results.sql).';
COMMENT ON COLUMN wasabi_variant.is_control IS 'TRUE for the baseline arm. Convenience for reporting; the engine does not treat control specially.';

-- ----------------------------------------------------------------------------
-- wasabi_assignment  — AUDIT ONLY.
--   Assignment is a deterministic pure function of (experiment.key, distinct_id)
--   via the PostHog-compatible hash (engine/src/hash.ts, engine/src/assignment.ts).
--   The engine recomputes the variant on every request and NEVER reads this table
--   to decide. It exists purely to (a) audit/replay what users actually saw and
--   (b) debug hash drift. Deleting every row here changes NO assignment.
-- ----------------------------------------------------------------------------
CREATE TABLE wasabi_assignment (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  distinct_id   TEXT        NOT NULL,
  experiment_id BIGINT      NOT NULL
                  REFERENCES wasabi_experiment(id) ON DELETE CASCADE,
  variant_key   TEXT        NOT NULL,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, distinct_id)
);

CREATE INDEX idx_wasabi_assignment_experiment ON wasabi_assignment (experiment_id);
CREATE INDEX idx_wasabi_assignment_distinct   ON wasabi_assignment (distinct_id);

COMMENT ON TABLE  wasabi_assignment IS
  'AUDIT ONLY. Assignment is deterministic (sha1(experimentKey.distinctId) -> variant, PostHog-compatible) so this table is NOT needed for correctness — the engine recomputes on every request and never reads it. Kept to replay what users saw and to debug hash drift.';
COMMENT ON COLUMN wasabi_assignment.distinct_id IS 'Our customer/anon id used as the hash input. Matches Transaction.customerId where the visitor is identified.';
COMMENT ON COLUMN wasabi_assignment.experiment_id IS 'FK -> wasabi_experiment.id.';
COMMENT ON COLUMN wasabi_assignment.variant_key IS 'The variant the deterministic hash produced for this (experiment, distinct_id). Should equal a wasabi_variant.key.';
COMMENT ON COLUMN wasabi_assignment.assigned_at IS 'First time we observed/recorded this assignment. Audit timestamp only.';

-- ----------------------------------------------------------------------------
-- wasabi_event  — generic funnel events (PostHog /capture shape).
--   For NON-payment funnel steps the DB does not already record, e.g.
--   "checkout_started", "form_step_2_viewed". Generic, schemaless via jsonb.
--
--   PAYMENT METRICS ARE DELIBERATELY NOT STORED HERE. auth/paid/rebill/refund/
--   revenue are NEVER duplicated into wasabi_event — they are the system of
--   record in global-api "Transaction" and are read from there, attributed to a
--   variant through Theme.slug. Duplicating them would create two conflicting
--   sources of truth for money. See decision-helper/results.sql.
-- ----------------------------------------------------------------------------
CREATE TABLE wasabi_event (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  distinct_id TEXT        NOT NULL,
  event       TEXT        NOT NULL,
  properties  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wasabi_event_distinct        ON wasabi_event (distinct_id);
CREATE INDEX idx_wasabi_event_event_ts        ON wasabi_event (event, ts);
CREATE INDEX idx_wasabi_event_properties_gin  ON wasabi_event USING GIN (properties);

COMMENT ON TABLE  wasabi_event IS
  'Generic funnel events (PostHog /capture shape) for non-payment steps the DB does not already record. PAYMENT METRICS ARE NOT STORED HERE — auth/paid/rebill/revenue come from the global-api "Transaction" table via Theme.slug (see decision-helper/results.sql). Never duplicate money here.';
COMMENT ON COLUMN wasabi_event.distinct_id IS 'Same identity as wasabi_assignment.distinct_id — lets funnel events be tied to a variant via the deterministic hash.';
COMMENT ON COLUMN wasabi_event.event IS 'Event name, e.g. "checkout_started", "form_step_completed". NOT a payment outcome.';
COMMENT ON COLUMN wasabi_event.properties IS 'Arbitrary event payload (jsonb). May carry experiment/variant context for funnel analysis.';
COMMENT ON COLUMN wasabi_event.ts IS 'Event timestamp.';

COMMIT;
