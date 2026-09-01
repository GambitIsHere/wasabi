// ============================================================================
// Auth.js module augmentation — puts orgId + role on the session/JWT/user.
// ----------------------------------------------------------------------------
// Requirement 5 (Batch D-a): the session carries org + role so server
// components/actions can authorize without a DB round-trip per render (see
// auth.ts's jwt/session callbacks, which populate these, and lib/tenant.ts's
// getCurrentTenant(), which reads them). Without this file every `session.role`
// / `token.orgId` access would need an `any` cast — house style forbids `any`.
//
// Type-only file (no runtime code) — imports MembershipRole from lib/roles.ts
// with `import type`, so this adds zero runtime dependency and can't
// participate in a module cycle.
// ============================================================================
import type { MembershipRole } from "@/lib/roles";

declare module "next-auth" {
  interface Session {
    /** The org this session is scoped to. Set by the jwt callback at sign-in
     *  from the membership row created/found there; absent only for a
     *  session minted before this batch shipped (getCurrentTenant() falls
     *  back to subdomain resolution in that case — see its header comment). */
    orgId?: string;
    /** The signed-in user's role within `orgId`. */
    role?: MembershipRole;
  }

  interface User {
    /** Populated either by auth.ts's Credentials `authorize()` directly, or
     *  by auth.config.ts's `signIn` callback mutating `user` in place for a
     *  Google sign-in (see that file's header comment for why the mutation
     *  is safe/verified) — either way, read by the jwt callback's first
     *  (sign-in) invocation. */
    orgId?: string;
    role?: MembershipRole;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    orgId?: string;
    role?: MembershipRole;
  }
}

// next-auth/jwt.d.ts is `export * from "@auth/core/jwt"` — a RE-EXPORT, not
// where `JWT` is originally declared. @auth/core's own callback signatures
// (what NextAuthConfig's `jwt`/`session` callbacks actually type-check
// against — verified: augmenting only "next-auth/jwt" above left
// `token.orgId` typed `unknown` inside the `session` callback) import JWT
// from "./jwt.js" i.e. this module. Both augmentations are kept: this one
// makes the callback parameters correctly typed; the one above covers any
// code that imports JWT directly from "next-auth/jwt" instead.
declare module "@auth/core/jwt" {
  interface JWT {
    orgId?: string;
    role?: MembershipRole;
  }
}
