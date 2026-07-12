import { runStrategyOnce } from "@/lib/strategy";
import { resolveRequestUserId } from "@/lib/request-user";
import { getPolicy } from "@/lib/db";
import { resolveLlmEndpoint } from "@/lib/llm-provider";
import { LLM_REQUIRED_STRATEGY_MESSAGE } from "@/lib/llm-required";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  // A strategy session is LLM-driven: gate it on a resolvable credential FOR THE MODEL proposeTrades
  // will actually call — resolveLlmEndpoint(policy).key, the same resolution the deep throw inside
  // proposeTrades uses — not "any provider". This makes the early 412 match the deep fail-loud throw,
  // so a user whose selected strategy model's provider has no key is blocked here instead of running a
  // loop that only errors deep inside proposeTrades. `summary` keeps the client's existing error rendering.
  if (!resolveLlmEndpoint(getPolicy(userId), userId).key) {
    return NextResponse.json({ status: "failed", summary: LLM_REQUIRED_STRATEGY_MESSAGE, proposals: [] }, { status: 412 });
  }
  const body = await request.json().catch(() => ({})) as { manual?: boolean } | null;
  const result = await runStrategyOnce(userId, { manual: body?.manual === true });
  // audit("strategy_run", ...) is now written inside runStrategyOnce() so the
  // scheduler path also records it — no need to write it here.
  return NextResponse.json(result, { status: result.status === "failed" ? 400 : 200 });
}
