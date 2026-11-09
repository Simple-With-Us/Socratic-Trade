import { updateSocraticFrameworkProposalStatus } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import type { SocraticFrameworkOwnerVerb, SocraticFrameworkProposalStatus } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const STATUSES = new Set<SocraticFrameworkProposalStatus>(["pending", "accepted", "rejected", "applied"]);
const OWNER_VERBS = new Set<SocraticFrameworkOwnerVerb>(["accept", "reject", "rewrite"]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await request.json().catch(() => ({}));
  const status = body.status;
  if (!STATUSES.has(status)) return NextResponse.json({ error: "invalid status" }, { status: 400 });
  const ownerResponse = typeof body.ownerResponse === "string" ? body.ownerResponse.trim() : undefined;
  const ownerVerb = OWNER_VERBS.has(body.ownerVerb) ? body.ownerVerb : undefined;
  if (ownerVerb === "rewrite" && status !== "accepted") {
    return NextResponse.json({ error: "rewrite must use accepted status" }, { status: 400 });
  }
  if (ownerVerb === "rewrite" && !ownerResponse) {
    return NextResponse.json({ error: "rewrite requires ownerResponse" }, { status: 400 });
  }
  const { id } = await context.params;
  const userId = resolveRequestUserId(request);
  const proposal = updateSocraticFrameworkProposalStatus(id, status, userId, ownerResponse, ownerVerb);
  if (!proposal) return NextResponse.json({ error: "framework proposal not found" }, { status: 404 });
  return NextResponse.json(proposal);
}
