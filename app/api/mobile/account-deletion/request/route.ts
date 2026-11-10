import { ACCOUNT_DELETE_PHRASE, getAccountDeletionPreview } from "@/lib/account-deletion";
import { resolveRequestUser } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function mobileDeletionRequest(user: { userId: string; email?: string }) {
  const preview = getAccountDeletionPreview(user);
  return {
    userId: user.userId,
    email: user.email,
    requiredText: ACCOUNT_DELETE_PHRASE,
    connectedAccounts: preview.connectedAccounts,
    blockers: preview.blockers,
    counts: preview.counts,
    steps: [
      "Review that backend account data, broker connections, provider keys, proposals, fills, watchlists, alerts, learned context, and normal audit events will be deleted for this app user.",
      user.email ? `Type your signed-in email: ${user.email}` : `Type your app user id: ${user.userId}`,
      `Type the exact phrase: ${ACCOUNT_DELETE_PHRASE}`,
      "Confirm deletion and sign out. Signing in later with the same provider creates a fresh app account.",
      "Optional: revoke this app in your provider account security settings if you also want to remove the provider-side OAuth grant."
    ]
  };
}

export async function GET(request: Request) {
  const user = resolveRequestUser(request);
  return NextResponse.json({ deletionRequest: mobileDeletionRequest(user) });
}

/**
 * Account-deletion review is deliberately read-only. Older native builds used POST here merely to
 * preview the steps, which installed the deletion fence and halted strategy state before the owner
 * had confirmed anything. Keep POST explicit and non-mutating so a stale client cannot recreate
 * that behavior.
 */
export async function POST() {
  return NextResponse.json(
    { error: "Account-deletion preview is read-only. Use GET, then confirm deletion explicitly." },
    { status: 405, headers: { Allow: "GET" } }
  );
}
