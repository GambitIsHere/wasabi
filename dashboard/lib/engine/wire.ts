// The HTTP wire contract — PostHog-shaped, so the official PostHog SDKs (and
// our own) speak it. Every layer (server, SDK, storefront hook) builds to THIS.
import type { FlagValue } from "./types";

/** POST /decide — given a user, return their flag/variant assignments (mirrors PostHog's /decide). */
export interface DecideRequest {
  distinctId: string;
  /** Optional person properties for targeting/segmentation (future use). */
  personProperties?: Record<string, string | number | boolean>;
}

export interface DecideResponse {
  /** flag/experiment key → value: `false` (not in flag) | `true` (boolean on) | variant key. */
  featureFlags: Record<string, FlagValue>;
  /** Sanjow convenience: experiment key → the storefront `?theme=` slug to route to. */
  themes: Record<string, string>;
}

/** POST /capture — record an event for a user (mirrors PostHog's /capture). */
export interface CaptureRequest {
  distinctId: string;
  /** e.g. "checkout_started" | "paid" | "rebill_ok" | "rebill_failed" | "churned". */
  event: string;
  properties?: Record<string, unknown>;
  /** ISO-8601; server stamps now when omitted. */
  timestamp?: string;
}

export interface CaptureResponse {
  status: 1;
}

/** GET /flags — list active experiments (debug/admin). */
export interface FlagsResponse {
  flags: Array<{ key: string; active: boolean; variants: string[] }>;
}
