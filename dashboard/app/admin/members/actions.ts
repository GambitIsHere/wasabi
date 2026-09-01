"use server";

// ============================================================================
// Approve a pending member — requirement 3(b)'s second way out of "pending"
// (the first being a clicked email-verification link, which has no real
// implementation yet — see lib/email-verification.ts).
// ----------------------------------------------------------------------------
// Role-gated: only an "admin" or "owner" (lib/roles.ts's roleAtLeast) of the
// TARGET user's own org may approve them. Two independent checks, both
// required — this is exactly the kind of authorization code where "checked
// one thing and assumed the other" is the whole bug:
//   1. the CALLER's session role — never trust a client-side "you're an
//      admin so this button is visible" render decision; re-derived from the
//      session's own role/orgId claims (set at sign-in — see auth.config.ts).
//   2. the TARGET's membership — re-fetched by (userId, the CALLER's own
//      orgId), not assumed from whatever org the pending-members list page
//      queried. An admin of org A can only ever approve a pending user IN
//      org A, even if (hypothetically) they passed a userId belonging to
//      org B — that lookup would come back null and this rejects.
// ============================================================================
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { getMembership } from "@/lib/membership";
import { roleAtLeast } from "@/lib/roles";
import { getUserById, setUserStatus } from "@/lib/users";

export type ApproveResult = { ok: true } | { ok: false; error: string };

export async function approvePendingUser(userId: string): Promise<ApproveResult> {
  const session = await auth();
  if (!session?.orgId || !session.role || !roleAtLeast(session.role, "admin")) {
    return { ok: false, error: "You don't have permission to approve members." };
  }

  const membership = await getMembership(userId, session.orgId);
  if (!membership) {
    return { ok: false, error: "That user isn't a member of your organization." };
  }

  const user = await getUserById(userId);
  if (!user) {
    return { ok: false, error: "User not found." };
  }
  if (user.status !== "pending") {
    return { ok: false, error: "That user isn't pending approval." };
  }

  await setUserStatus(userId, "active");
  revalidatePath("/admin/members");
  return { ok: true };
}
