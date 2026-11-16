import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { getPolicy } from "@/lib/db";
import { isUnavailableModelResolutionError, resolveLlmEndpoint } from "@/lib/llm-provider";
import {
  getStrategyRunRequest,
  processPendingStrategyRunRequests,
  queueStrategyRunRequest
} from "@/lib/strategy-run-requests";
import { eligibleRotationPool, isModelRotationSentinel } from "@/lib/model-rotation";
import {
  LLM_MODEL_REQUIRED_STRATEGY_MESSAGE,
  LLM_REQUIRED_STRATEGY_MESSAGE,
  LLM_ROTATION_AVAILABILITY_UNAVAILABLE_STRATEGY_MESSAGE,
  LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE
} from "@/lib/llm-required";
import { after, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  const policy = getPolicy(userId);
  if (isModelRotationSentinel(policy.llmModel)) {
    // Green is "__rotate__": this precheck resolves the PERSISTED policy, where resolveOpenAiModel
    // deliberately treats the sentinel as unset (llm-request.ts safety net for non-run consumers),
    // so the key/model gates below would 412 EVERY manual run even though runStrategyOnce resolves
    // rotation to a concrete model at the top of the run (strategy.ts) — scheduled runs never hit
    // this precheck, which is why only Run-once was blocked. Gate on what the run will ACTUALLY
    // serve instead: the credential-filtered rotation pool. Non-empty means some concrete,
    // key-resolvable model serves this run — let it through. Empty means the run would fail closed
    // anyway (rotation resolves the seat to ""), so 412 now with the actionable rotation message.
    // (A RED "__rotate__" needs no gate here for the same reason a blank red model doesn't — see
    // the blank-red note below.)
    const eligible = await eligibleRotationPool(userId);
    if (eligible.pool.length === 0) {
      return NextResponse.json(
        {
          status: "failed",
          summary:
            eligible.availability === "unavailable"
              ? LLM_ROTATION_AVAILABILITY_UNAVAILABLE_STRATEGY_MESSAGE
              : LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE,
          proposals: []
        },
        { status: 412 }
      );
    }
  } else {
    // A strategy session is LLM-driven: gate it on a resolvable credential FOR THE MODEL proposeTrades
    // will actually call — resolveLlmEndpoint(policy).key, the same resolution the deep throw inside
    // proposeTrades uses — not "any provider". This makes the early 412 match the deep fail-loud throw,
    // so a user whose selected strategy model's provider has no key is blocked here instead of running a
    // loop that only errors deep inside proposeTrades. `summary` keeps the client's existing error rendering.
    let greenEndpoint: ReturnType<typeof resolveLlmEndpoint>;
    try {
      greenEndpoint = resolveLlmEndpoint(policy, userId);
    } catch (error) {
      // The chosen model cannot run on this user's route (e.g. a Code CLI-only model while Meta is
      // not on Code CLI, or Code CLI not configured): a legible 412, not a 500.
      if (!isUnavailableModelResolutionError(error)) throw error;
      return NextResponse.json({ status: "failed", summary: (error as Error).message, proposals: [] }, { status: 412 });
    }
    if (!greenEndpoint.key) {
      return NextResponse.json({ status: "failed", summary: LLM_REQUIRED_STRATEGY_MESSAGE, proposals: [] }, { status: 412 });
    }
    // NO MODEL DEFAULTS (owner directive 2026-07-07): a blank Green model resolves to "" and the deep
    // proposeTrades backstop fails closed with the same message — pre-check here so the user gets the
    // actionable 412 instead of a failed run. (A blank RED model does not 412: the run still produces
    // proposals, and debateProposal fails closed per-opening → routed to human approval, which is the
    // legible consequence the owner accepted for un-migrated policies.)
    if (!greenEndpoint.model) {
      return NextResponse.json({ status: "failed", summary: LLM_MODEL_REQUIRED_STRATEGY_MESSAGE, proposals: [] }, { status: 412 });
    }
  }
  const body = await request.json().catch(() => ({})) as { manual?: boolean } | null;

  // Persist first, then return.  Unlike a detached in-process promise, this request survives an
  // app restart and has a real run id the client can poll.  The route only kicks a worker;
  // scheduler ticks drain any queued request left behind by a crash/redeploy.
  const queued = queueStrategyRunRequest({ userId, manual: body?.manual === true });
  // Immediate kick starts gather/Green in this process.  `after()` keeps a
  // second kick after the 202 so Next request teardown cannot leave a claimed
  // `running` row with no worker (live Roth `9d71dda4`: drain only selected
  // `queued`, so every later tick journaled skipped and Green never started).
  const kick = (): void => {
    void processPendingStrategyRunRequests({ limit: 1 }).catch((error) => {
      console.error("[api/strategy/run] durable run worker kick failed:", error);
    });
  };
  kick();
  try {
    after(kick);
  } catch {
    /* route unit tests call POST without a Next request scope */
  }
  return NextResponse.json(
    {
      runId: queued.request.id,
      status: "queued",
      summary: queued.deduped
        ? "A manual run is already queued or in progress.  Check Activity for progress."
        : "Run queued — execution can take a few minutes.  Check Activity for progress.",
      proposals: []
    },
    { status: 202 }
  );
}

/** Read the durable request receipt. */
export async function GET(request: Request) {
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runId is required." }, { status: 400 });
  const result = getStrategyRunRequest(runId, userId);
  if (!result) return NextResponse.json({ error: "Run request not found." }, { status: 404 });
  return NextResponse.json(result);
}
