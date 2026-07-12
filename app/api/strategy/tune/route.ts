import { proposeStrategyTuning } from "@/lib/strategy-tuning";
import { validateTuningInvariants } from "@/lib/tuning-invariants";
import { getPolicy } from "@/lib/db";
import { ALL_LLM_REASONING_EFFORTS } from "@/lib/llm-request";
import type { LlmReasoningEffort } from "@/lib/types";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const reasoningEffort: LlmReasoningEffort | undefined =
      ALL_LLM_REASONING_EFFORTS.includes(body?.reasoningEffort) ? body.reasoningEffort : undefined;
    const userId = resolveRequestUserId(request);
    const proposal = await proposeStrategyTuning(userId, model, reasoningEffort);
    // P0-3: in the MANUAL path, tuning-config invariant violations are surfaced as WARNINGS (never blocks) —
    // the human reviews them alongside the proposal. (The AUTONOMOUS path fails closed on the same set.)
    // The dashboard renders `proposal.cautions`, so APPEND the warnings there (with a clear prefix) so manual
    // users actually SEE them; also keep the structured `tuningConfigWarnings` field for programmatic callers.
    const invariants = validateTuningInvariants(getPolicy(userId).tuning);
    if (invariants.ok) {
      return NextResponse.json(proposal);
    }
    const warningCautions = invariants.violations.map((v) => `Tuning-config warning: ${v.message}`);
    return NextResponse.json({
      ...proposal,
      cautions: [...(proposal.cautions ?? []), ...warningCautions],
      tuningConfigWarnings: invariants.violations
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Strategy tuning failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
