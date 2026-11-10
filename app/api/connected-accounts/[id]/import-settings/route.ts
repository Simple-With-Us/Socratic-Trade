import { ImportAccountSettingsError, importAccountSettings } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Import another connected account's own live strategy settings onto THIS one — fully general
// any→any (e.g. paper→live, or the reverse). [id] is the TARGET account; the body names the
// SOURCE. Unlike /api/profiles/[id]/copy (which copies a saved library profile), this copies a
// sibling account's live account_strategy_state row. See importAccountSettings in db-profiles.ts
// for the copy/strip/provenance rules (identity fields stripped, user-level fields stripped, the
// target's own systemState is always preserved).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: targetConnectedAccountId } = await context.params;
  try {
    const body = (await request.json().catch(() => ({}))) as { sourceConnectedAccountId?: unknown };
    const sourceConnectedAccountId =
      typeof body.sourceConnectedAccountId === "string" ? body.sourceConnectedAccountId.trim() : "";
    if (!sourceConnectedAccountId) {
      return NextResponse.json({ error: "sourceConnectedAccountId is required." }, { status: 400 });
    }

    const userId = resolveRequestUserId(request);
    const policy = importAccountSettings(userId, sourceConnectedAccountId, targetConnectedAccountId);
    return NextResponse.json({ ok: true, policy });
  } catch (error) {
    if (error instanceof ImportAccountSettingsError) {
      const status = error.code === "not_found" ? 404 : error.code === "no_source_state" ? 409 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Import failed." }, { status: 400 });
  }
}
