import { NextRequest, NextResponse } from "next/server";
import {
  checkLlmDailyBudget,
  getUserLlmDailyBudget,
  resolveLlmLimits,
  setUserLlmDailyBudget
} from "@/lib/llm-budget";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

function finiteOrNull(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

function parseOptionalBudget(raw: unknown, field: string): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${field} must be a non-negative number, or blank to clear.`);
  }
  return n;
}

function payloadFor(userId: string) {
  const stored = getUserLlmDailyBudget(userId);
  const limits = resolveLlmLimits(userId);
  const today = checkLlmDailyBudget(userId);
  return {
    ok: true,
    tokenBudget: stored.tokenBudget ?? null,
    costBudgetUsd: stored.costBudgetUsd ?? null,
    effective: {
      tokenLimit: finiteOrNull(limits.tokenLimit),
      costLimitUsd: finiteOrNull(limits.costLimit),
      tokenSource: limits.tokenSource,
      costSource: limits.costSource
    },
    today: {
      tokens: today.tokensToday ?? 0,
      costUsd: today.costUsdToday ?? 0
    },
    enforced: Number.isFinite(limits.tokenLimit) || Number.isFinite(limits.costLimit)
  };
}

/** GET — per-user daily LLM cap + today's spend. Not an Infisical secret. */
export async function GET(request: NextRequest) {
  const userId = resolveRequestUserId(request, {});
  return NextResponse.json(payloadFor(userId));
}

/**
 * PATCH — { tokenBudget?: number | null, costBudgetUsd?: number | null }
 * null / blank clears that user override (legacy policy + retired env may still bind).
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      tokenBudget?: number | null;
      costBudgetUsd?: number | null;
    };
    const userId = resolveRequestUserId(request, body);
    const tokenBudget = parseOptionalBudget(body.tokenBudget, "tokenBudget");
    const costBudgetUsd = parseOptionalBudget(body.costBudgetUsd, "costBudgetUsd");
    if (tokenBudget === undefined && costBudgetUsd === undefined) {
      return NextResponse.json({ error: "tokenBudget or costBudgetUsd is required." }, { status: 400 });
    }
    setUserLlmDailyBudget(userId, { tokenBudget, costBudgetUsd });
    return NextResponse.json(payloadFor(userId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("must be a non-negative") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
