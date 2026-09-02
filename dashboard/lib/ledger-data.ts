// ============================================================================
// Experiment Ledger — the VWO back-catalogue, pulled apart to page / element /
// change / result. Snapshot taken from VWO (Wingify) on 2026-09-02 across the
// six-month window; 37 campaigns, 4 brands. This is a static reference (the
// design intelligence, not a live feed) — /ledger renders it behind the same
// sign-in as the rest of the tool. Refresh by re-pulling the VWO reports.
//
// "lift" is the point-estimate improvement of the best arm over control on the
// primary goal; "prob" is VWO's probability-to-beat. A test only counts as a
// real winner at prob >= 95, which NONE here reached — verdicts are directional.
// ============================================================================

export type Verdict = "win" | "loss" | "flat" | "nodata";
export type Brand = "AC" | "TU" | "PDF" | "AS";

export interface Experiment {
  id: number;
  name: string;
  brand: Brand;
  type: "AB" | "Split";
  page: string;
  element: string;
  variants: string;
  goal: string;
  ctrl: string;
  best: string;
  lift: number;
  prob: number;
  n: number;
  days: number;
  verdict: Verdict;
  flags: string[];
  group: string;
  live?: boolean;
}

export interface LedgerGroup {
  key: string;
  title: string;
  desc: string;
}

export const BRAND_NAMES: Record<Brand, string> = {
  AC: "Airport Check-In",
  TU: "Top Up",
  PDF: "PDF SaaS",
  AS: "Airport Security",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  win: "Directional win",
  loss: "Directional loss",
  flat: "Flat",
  nodata: "No data",
};

export const LEDGER_GROUPS: LedgerGroup[] = [
  {
    key: "bgcta",
    title: "Airport Check-In — Background × CTA colour",
    desc: "The biggest programme: on the dark check-in hero, does a light background and/or an airline-branded “Boarding Pass” button lift check-in conversion? Two waves — JS-injected AB per airline, then split-URL redesigns. The airline-coloured CTA on the dark background is the recurring near-winner; the light backgrounds lost. Nothing was powered enough to prove it.",
  },
  {
    key: "acother",
    title: "Airport Check-In — trust, upsell, pricing",
    desc: "Trustpilot widgets, the Nylas connect-your-inbox upsell, no-logo layouts and plan pricing. The two Trustpilot tests are the only two VWO ever concluded — both no-winner. Nylas hurt confirmation. Includes the A/A instrument check.",
  },
  {
    key: "tu",
    title: "Top Up — billing price & landing",
    desc: "Price-point splits (39/49, 39/19, retry 29/19) across UK, DE, RO, FR, ES, plus the USP banner and the Serenity theme. The alternate prices came in flat-to-negative everywhere; the USP banner helps mid-funnel but not final CVR.",
  },
  {
    key: "pdf",
    title: "PDF SaaS — checkout",
    desc: "An optional phone field on the payment page (cost −22%) and a biweekly-£19 billing rollout that has no honest control.",
  },
  {
    key: "as",
    title: "Airport Security — booking hero",
    desc: "GP-452: inverting the Exec Pass booking hero from dark to light. Running now and directionally ahead (+7.4% thankyou at 75%). This is the “AS dark vs light” test.",
  },
];

export const EXPERIMENTS: Experiment[] = [
  { id: 338, name: "All airlines · Check-in BG+CTA", brand: "AC", type: "AB", page: "Check-in landing — Boarding Pass form (dark #1a1a2e hero)", element: "Hero background + colour of the “Boarding Pass” submit button", variants: "Control (dark bg + dark CTA) · V1 dark bg + airline-colour CTA · V2 light bg + dark CTA · V3 light bg + airline CTA", goal: "Check-in conversion", ctrl: "5.34%", best: "V1 7.92%", lift: 48.35, prob: 66, n: 2042, days: 4, verdict: "win", flags: ["underpowered"], group: "bgcta" },
  { id: 342, name: "Ryanair · Check-in BG+CTA", brand: "AC", type: "AB", page: "Check-in landing — Ryanair", element: "Airline-blue CTA (#073590) on dark hero vs light-bg arms", variants: "C dark/dark · V1 dark + Ryanair-blue CTA · V2/V3 light bg", goal: "Check-in conversion", ctrl: "2.89%", best: "V1 5.40%", lift: 86.83, prob: 0, n: 877, days: 7, verdict: "win", flags: ["underpowered"], group: "bgcta" },
  { id: 343, name: "Vueling · Check-in BG+CTA", brand: "AC", type: "AB", page: "Check-in landing — Vueling", element: "Airline-yellow CTA (#FFCC00) on dark hero vs light-bg arms", variants: "C dark/dark · V1 dark + Vueling-yellow CTA · V2/V3 light bg", goal: "Check-in conversion", ctrl: "1.02%", best: "V1 5.29%", lift: 418.82, prob: 0, n: 541, days: 7, verdict: "win", flags: ["tiny n (9 conv)"], group: "bgcta" },
  { id: 341, name: "WizzAir · Check-in BG+CTA", brand: "AC", type: "AB", page: "Check-in landing — WizzAir", element: "Airline-magenta CTA (#C6007E) on dark hero vs light-bg arms", variants: "C dark/dark · V1 dark + magenta CTA · V2/V3 light bg", goal: "Check-in conversion", ctrl: "2.35%", best: "V1 2.16%", lift: -8.31, prob: 0, n: 1545, days: 7, verdict: "flat", flags: ["V1 +31% lands-on-checkout"], group: "bgcta" },
  { id: 346, name: "Turkish Airlines · Check-in BG+CTA", brand: "AC", type: "AB", page: "Check-in landing — Turkish", element: "Airline-red CTA (#E81932) on dark hero vs light-bg arms", variants: "C dark/dark · V1 dark + red CTA · V2 light + dark · V3 light + red", goal: "Check-in conversion", ctrl: "0.93%", best: "V2 1.16%", lift: 24.81, prob: 0, n: 975, days: 7, verdict: "nodata", flags: ["near-zero conv (7 total)"], group: "bgcta" },
  { id: 340, name: "easyJet · Check-in BG+CTA", brand: "AC", type: "AB", page: "Check-in landing — easyJet", element: "Airline-orange CTA (#FF6600) on dark hero vs light-bg arms", variants: "C dark/dark · V1 dark + orange CTA · V2/V3 light bg", goal: "Check-in conversion", ctrl: "1.26%", best: "C 1.26%", lift: 0, prob: 0, n: 487, days: 7, verdict: "nodata", flags: ["3 conv total"], group: "bgcta" },
  { id: 344, name: "HiSky · Check-in BG+CTA", brand: "AC", type: "AB", page: "Check-in landing — HiSky", element: "Airline CTA (#F89923) on dark hero vs light-bg arms", variants: "C dark/dark · V1 dark + airline CTA · V2/V3 light bg", goal: "Check-in conversion", ctrl: "0.00%", best: "V1 2.50%", lift: 0, prob: 0, n: 128, days: 7, verdict: "nodata", flags: ["1 conv total"], group: "bgcta" },
  { id: 345, name: "Kiwi · Check-in BG+CTA", brand: "AC", type: "AB", page: "Check-in landing — Kiwi", element: "Airline-teal CTA (#00A991) on dark hero vs light-bg arms", variants: "C dark/dark · V1 dark + teal CTA · V2/V3 light bg", goal: "Check-in conversion", ctrl: "0.00%", best: "V1 1.30%", lift: 0, prob: 0, n: 222, days: 7, verdict: "nodata", flags: ["1 conv total"], group: "bgcta" },
  { id: 328, name: "Check-in CTA · Colour test", brand: "AC", type: "AB", page: "Check-in landing — CTA button", element: "Magenta Wizz CTA + GA4 tracking; and a grey→magenta “activate on valid form” state", variants: "Control · Wizz Colours · Active-on-validation", goal: "Check-in conversion", ctrl: "7.97%", best: "V1 7.90%", lift: -0.81, prob: 0, n: 826, days: 10, verdict: "flat", flags: [], group: "bgcta" },
  { id: 330, name: "easyJet · BGCTA 01 (split)", brand: "AC", type: "Split", page: "Check-in landing — easyJet redesign", element: "Full split-URL page variants of the BG+CTA concept", variants: "Control 1% + 4 variants", goal: "Lands on checkout", ctrl: "—", best: "V2 69%", lift: 0, prob: 0, n: 77, days: 2, verdict: "nodata", flags: ["broken tracking"], group: "bgcta" },
  { id: 336, name: "Turkish · BGCTA 07 (split)", brand: "AC", type: "Split", page: "Check-in landing — Turkish redesign", element: "Split-URL BG+CTA page variants", variants: "Control 1% + 4 variants", goal: "Lands on checkout", ctrl: "0%", best: "V4 30%", lift: 0, prob: 0, n: 159, days: 2, verdict: "nodata", flags: ["broken tracking"], group: "bgcta" },
  { id: 331, name: "WizzAir · BGCTA 02 (split)", brand: "AC", type: "Split", page: "Check-in landing — WizzAir redesign", element: "Split-URL BG+CTA page variants", variants: "Control 1% + 4 variants", goal: "Lands on checkout", ctrl: "—", best: "—", lift: 0, prob: 0, n: 1, days: 1, verdict: "nodata", flags: ["no traffic"], group: "bgcta" },
  { id: 333, name: "WizzAir · BGCTA 04 (split)", brand: "AC", type: "Split", page: "Check-in landing — WizzAir redesign", element: "Split-URL BG+CTA page variants", variants: "Control + 4 variants", goal: "Lands on checkout", ctrl: "0%", best: "V4 35%", lift: 0, prob: 0, n: 171, days: 2, verdict: "nodata", flags: ["broken tracking"], group: "bgcta" },
  { id: 334, name: "Ryanair · BGCTA 05 (split)", brand: "AC", type: "Split", page: "Check-in landing — Ryanair redesign", element: "Split-URL BG+CTA page variants", variants: "Control 0.1% + 4 variants", goal: "Lands on checkout", ctrl: "—", best: "V4 33%", lift: 0, prob: 0, n: 231, days: 2, verdict: "nodata", flags: ["bounce 100% on 2 arms"], group: "bgcta" },
  { id: 335, name: "Vueling · BGCTA 06 (split)", brand: "AC", type: "Split", page: "Check-in landing — Vueling redesign", element: "Split-URL BG+CTA page variants", variants: "Control 1% + 4 variants", goal: "Lands on checkout", ctrl: "0%", best: "V4 60%", lift: 0, prob: 0, n: 71, days: 2, verdict: "nodata", flags: ["broken tracking"], group: "bgcta" },
  { id: 349, name: "No-logo + CTA · All airlines", brand: "AC", type: "Split", page: "Check-in landing (all airlines)", element: "Removed the airline logo, adjusted CTA — 3 full page variants", variants: "Control · V1 · V2", goal: "Confirmation CvR", ctrl: "5.08%", best: "V2 5.29%", lift: 4.04, prob: 71, n: 37654, days: 14, verdict: "flat", flags: ["bounce +11% worse", "best-powered AC test"], group: "acother" },
  { id: 319, name: "Checkout · Trustpilot carousel", brand: "AC", type: "AB", page: "Check-in checkout", element: "Appended a Trustpilot TrustBox review widget", variants: "Control · Trustpilot carousel", goal: "Check-in conversion", ctrl: "4.24%", best: "V1 4.29%", lift: 1.25, prob: 52, n: 32577, days: 30, verdict: "flat", flags: ["concluded: no winner"], group: "acother" },
  { id: 318, name: "Homepage · Trustpilot widget", brand: "AC", type: "AB", page: "Check-in homepage", element: "Injected a Trustpilot widget under the form button", variants: "Control · Trustpilot widget", goal: "User going to checkout", ctrl: "34.78%", best: "V1 34.58%", lift: -0.58, prob: 16, n: 29851, days: 21, verdict: "loss", flags: ["thankyou −10%", "concluded: no winner"], group: "acother" },
  { id: 357, name: "GP-69 · Nylas on AC", brand: "AC", type: "AB", page: "Check-in confirmation flow", element: "Nylas “connect your inbox” before / after payment (session flag)", variants: "No Nylas · Nylas on LP · Nylas after payment", goal: "Confirmation CvR", ctrl: "3.36%", best: "V2 3.20%", lift: -4.82, prob: 19, n: 47369, days: 14, verdict: "loss", flags: ["bounce “win” = artifact"], group: "acother" },
  { id: 369, name: "Nylas connect-your-inbox · Wizzair EN", brand: "AC", type: "Split", page: "Check-in — Wizzair EN", element: "Nylas connect flow, dedicated event tracking", variants: "Control · Variation 1", goal: "Purchase / thankyou", ctrl: "0%", best: "0%", lift: 0, prob: 0, n: 31, days: 1, verdict: "nodata", flags: ["10% traffic, 0 conv"], group: "acother" },
  { id: 355, name: "Biweekly 24.9 vs Quarterly 79", brand: "AC", type: "Split", page: "Check-in billing", element: "Billing plan / price framing", variants: "Control · Variation 1", goal: "Confirmation CvR", ctrl: "—", best: "—", lift: 0, prob: 0, n: 0, days: 1, verdict: "nodata", flags: ["no traffic recorded"], group: "acother" },
  { id: 361, name: "AC · Test", brand: "AC", type: "Split", page: "Check-in", element: "Scaffold / smoke test", variants: "Control · Variation 1", goal: "Confirmation CvR", ctrl: "—", best: "—", lift: 0, prob: 0, n: 0, days: 1, verdict: "nodata", flags: ["empty test"], group: "acother" },
  { id: 316, name: "A/A Test · AB demo", brand: "AC", type: "AB", page: "Instrument check", element: "No change — identical A vs A", variants: "Control · Variation 1 (identical)", goal: "Thankyou (conv)", ctrl: "1.64%", best: "V1 1.69%", lift: 3.34, prob: 53, n: 43710, days: 13, verdict: "flat", flags: ["validates setup — noise as expected"], group: "acother" },
  { id: 362, name: "GP-303 · TU header USP banner", brand: "TU", type: "AB", page: "Top Up landing — above the header / below the card", element: "Rotating multilingual USP banner (instant delivery · secure payment · 24/7), 11 languages, CLS-guarded", variants: "Control (no USPs) · Top-bar USPs · Below-card USPs", goal: "Paid apps CVR", ctrl: "3.49%", best: "V1 3.47%", lift: -0.58, prob: 40, n: 29107, days: 16, verdict: "flat", flags: ["reach-payment +2.8% @87%"], group: "tu" },
  { id: 350, name: "Billing test 39 + 19 · UK #2", brand: "TU", type: "Split", page: "Top Up billing / checkout", element: "£39 vs £19 billing price point", variants: "Control · Variation 1", goal: "Thankyou (conv)", ctrl: "3.50%", best: "V1 3.38%", lift: -3.53, prob: 39, n: 43943, days: 53, verdict: "loss", flags: [], group: "tu" },
  { id: 324, name: "Billing test 39/49 · DE", brand: "TU", type: "Split", page: "Top Up billing — Germany", element: "39 vs 49 billing price point", variants: "Control · Variation 1", goal: "Thankyou (conv)", ctrl: "1.69%", best: "V1 1.38%", lift: -18.3, prob: 47, n: 5278, days: 22, verdict: "loss", flags: [], group: "tu" },
  { id: 323, name: "Billing test 39/49 · RO", brand: "TU", type: "Split", page: "Top Up billing — Romania", element: "39 vs 49 billing price point", variants: "Control · Variation 1", goal: "Thankyou (conv)", ctrl: "3.05%", best: "V1 1.33%", lift: -56.44, prob: 36, n: 4376, days: 22, verdict: "loss", flags: ["strong negative"], group: "tu" },
  { id: 339, name: "Billing test 39/49 · UK", brand: "TU", type: "Split", page: "Top Up billing — UK", element: "39 vs 49 billing price point", variants: "Control · Variation 1", goal: "Thankyou (conv)", ctrl: "4.65%", best: "V1 3.92%", lift: -15.69, prob: 0, n: 188, days: 1, verdict: "nodata", flags: ["tiny n"], group: "tu" },
  { id: 363, name: "Billing · no prepaid · UK", brand: "TU", type: "Split", page: "Top Up billing — UK", element: "Billing page without the prepaid option", variants: "Control 1% · Variation 1", goal: "Thankyou (conv)", ctrl: "3.55%", best: "V1 3.30%", lift: -7.01, prob: 0, n: 11634, days: 22, verdict: "loss", flags: ["control starved 1%"], group: "tu" },
  { id: 315, name: "Retry · 29/19 · FR", brand: "TU", type: "Split", page: "Top Up retry / dunning", element: "29 vs 19 retry price, two variants", variants: "Control 1% · V1 · V2", goal: "Purchases (onboarding)", ctrl: "0.00%", best: "V1 0.17%", lift: 0, prob: 0, n: 18167, days: 44, verdict: "loss", flags: ["CTA click −22%", "near-zero purchase"], group: "tu" },
  { id: 314, name: "Retry · 29/19 · ES", brand: "TU", type: "Split", page: "Top Up retry / dunning", element: "29 vs 19 retry price, two variants", variants: "Control 1% · V1 · V2", goal: "Purchases (onboarding)", ctrl: "0.00%", best: "V2 0.05%", lift: 0, prob: 0, n: 3758, days: 4, verdict: "loss", flags: ["CTA click −41%"], group: "tu" },
  { id: 351, name: "Serenity test · IE", brand: "TU", type: "Split", page: "Top Up IE landing", element: "“Serenity” landing theme", variants: "Control 1% · Variation 1", goal: "Thankyou (conv)", ctrl: "4.88%", best: "V1 2.29%", lift: -53.1, prob: 0, n: 825, days: 17, verdict: "nodata", flags: ["control starved 1%"], group: "tu" },
  { id: 356, name: "Serenity test · IE (.landing)", brand: "TU", type: "Split", page: "Top Up IE landing", element: "“Serenity” theme on the .landing template", variants: "Control 1% · Variation 1", goal: "Thankyou (conv)", ctrl: "0%", best: "0%", lift: 0, prob: 0, n: 615, days: 3, verdict: "nodata", flags: ["0 conv"], group: "tu" },
  { id: 329, name: "Checkout · add phone field", brand: "PDF", type: "AB", page: "PDF payment page", element: "Injected an optional phone field beside email (cloned + re-enabled)", variants: "Control · With phone field", goal: "Purchases (onboarding)", ctrl: "4.87%", best: "V1 3.80%", lift: -21.87, prob: 34, n: 8563, days: 8, verdict: "loss", flags: [], group: "pdf" },
  { id: 366, name: "CHK · Billing biweekly 19", brand: "PDF", type: "Split", page: "PDF checkout billing", element: "Biweekly £19 billing page (rollout-style)", variants: "Control 1% · Variation 99%", goal: "Purchases (onboarding)", ctrl: "0.00%", best: "V1 4.21%", lift: 0, prob: 0, n: 6775, days: 21, verdict: "nodata", flags: ["running", "control 1%", "goal changed"], group: "pdf", live: true },
  { id: 364, name: "GP-452 · Exec Pass hero inverse", brand: "AS", type: "AB", page: "AS UK — Exec Pass booking hero", element: "Inverted the #booking hero dark→light: white grid, navy text, light gradient, restyled airport/date/time inputs", variants: "Control (dark hero) · V1 light hero", goal: "AS — ThankYou", ctrl: "15.68%", best: "V1 16.83%", lift: 7.36, prob: 75, n: 3420, days: 14, verdict: "win", flags: ["running", "5 days left", "goal changed once"], group: "as", live: true },
];
