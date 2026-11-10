import { listSocraticFrameworkProposals } from "@/lib/db";
import { reviewPendingFrameworkProposals } from "@/lib/framework-review";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Run the batched single-LLM-call reviewer over all PENDING framework proposals (across
 *  the user's accounts) and attach an advisory recommendation to each. Returns the review
 *  summary plus the refreshed proposal list so the client can re-render in place. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const userId = resolveRequestUserId(request);
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const result = await reviewPendingFrameworkProposals(userId, limit ? { limit } : {});
  const proposals = listSocraticFrameworkProposals(userId, { limit: 25 });
  return NextResponse.json({ ...result, proposals });
}
