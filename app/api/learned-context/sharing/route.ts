import { NextResponse } from "next/server";
import { getLearnedContextSharing, setLearnedContextSharing } from "@/lib/db-settings";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

/** GET /api/learned-context/sharing — return the user's current sharing preferences. */
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const prefs = getLearnedContextSharing(userId);
  return NextResponse.json(prefs);
}

/** PUT /api/learned-context/sharing — update one or both sharing flags. */
export async function PUT(request: Request) {
  const userId = resolveRequestUserId(request);
  let body: { includeShared?: boolean; contributeShared?: boolean } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const updates: { includeShared?: boolean; contributeShared?: boolean } = {};
  if (typeof body.includeShared === "boolean") updates.includeShared = body.includeShared;
  if (typeof body.contributeShared === "boolean") updates.contributeShared = body.contributeShared;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields provided" }, { status: 400 });
  }
  const prefs = setLearnedContextSharing(userId, updates);
  return NextResponse.json(prefs);
}
