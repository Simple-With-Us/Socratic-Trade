import { getActiveConnectedAccount, getPolicy, getProposalsByIds } from "@/lib/db";
import { deriveExecutionState } from "@/lib/execution-mode";
import { resolvePlacementOutcome } from "@/lib/placement-outcome";
import {
  liveApprovalText,
  liveBatchApprovalText
} from "@/lib/strategy";
import { STOPPED_PROPOSAL_ACTION_MESSAGE, isProposalActionStopped } from "@/lib/proposal-actions";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { NextResponse } from "next/server";
import { executeProposal, LiveApprovalConfirmationError, LiveApprovalConfirmation } from "@/lib/strategy-execution";
import { LANE_WAITS } from "@/lib/account-mutation";

export const dynamic = "force-dynamic";

const BULK_APPROVE_MAX_REQUESTS = RATE_LIMITS.orders.limit;

type ProposalRow = NonNullable<ReturnType<typeof getProposalsByIds> extends Map<string, infer Row> ? Row : never>;

function proposalExecutionMode(row: ProposalRow, currentMode: ReturnType<typeof deriveExecutionState>["mode"]) {
  return row.executionMode ?? currentMode;
}

function liveRowsForBatch(rows: ProposalRow[], currentMode: ReturnType<typeof deriveExecutionState>["mode"]) {
  return rows.filter((row) => proposalExecutionMode(row, currentMode) === "broker/live");
}

function bulkExpectedText(liveRows: ProposalRow[]): string | undefined {
  if (liveRows.length === 0) return undefined;
  if (liveRows.length === 1) return liveApprovalText(liveRows[0].proposal.symbol);
  return liveBatchApprovalText(liveRows.length);
}

function requireBatchConfirmation(input: {
  typedText?: unknown;
  expectedText?: string;
  requireTypedConfirmation: boolean;
}) {
  if (!input.expectedText || !input.requireTypedConfirmation) return;
  const typedText = String(input.typedText ?? "").trim().toUpperCase();
  if (typedText === input.expectedText) return;
  throw new LiveApprovalConfirmationError(
    [`Type ${input.expectedText} to approve this live batch.`],
    input.expectedText
  );
}

function perProposalLiveConfirmation(row: ProposalRow): LiveApprovalConfirmation {
  return {
    proposalId: row.id,
    accountNumber: row.accountNumber,
    executionMode: "broker/live",
    estimatedNotional: row.estimatedNotional ?? row.review?.estimatedNotional ?? null,
    typedText: liveApprovalText(row.proposal.symbol)
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      proposalIds?: unknown;
      liveConfirmation?: { typedText?: unknown };
      userId?: unknown;
    };
    const userId = resolveRequestUserId(request, body);
    const proposalIds = Array.isArray(body.proposalIds)
      ? Array.from(new Set(body.proposalIds.filter((id): id is string => typeof id === "string" && id.length > 0)))
      : [];

    if (proposalIds.length === 0) {
      return NextResponse.json({ error: "invalid_proposal_ids", message: "Select at least one proposal." }, { status: 400 });
    }
    if (proposalIds.length > BULK_APPROVE_MAX_REQUESTS) {
      return NextResponse.json(
        {
          error: "bulk_approve_limit",
          message: `Select ${BULK_APPROVE_MAX_REQUESTS} or fewer proposals per batch.`
        },
        { status: 400 }
      );
    }

    // Charge the existing order limiter once per proposal, not once per HTTP request.
    for (const _id of proposalIds) {
      const limited = enforceRateLimit(userId, "proposals/approve", RATE_LIMITS.orders);
      if (limited) return limited;
    }

    const policy = getPolicy(userId);
    if (isProposalActionStopped(policy)) {
      return NextResponse.json(
        { error: "system_stopped", message: STOPPED_PROPOSAL_ACTION_MESSAGE },
        { status: 409 }
      );
    }

    const rowsById = getProposalsByIds(proposalIds, userId);
    const rows = proposalIds.map((id) => rowsById.get(id)).filter((row): row is ProposalRow => Boolean(row));
    const missingIds = proposalIds.filter((id) => !rowsById.has(id));
    if (missingIds.length > 0) {
      return NextResponse.json(
        { error: "proposal_not_found", message: "One or more selected proposals no longer exists.", missingIds },
        { status: 404 }
      );
    }

    const executionState = deriveExecutionState(policy, getActiveConnectedAccount(userId));
    const liveRows = liveRowsForBatch(rows, executionState.mode);
    requireBatchConfirmation({
      typedText: body.liveConfirmation?.typedText,
      expectedText: bulkExpectedText(liveRows),
      requireTypedConfirmation: policy.requireTypedConfirmation !== false
    });

    // Share ONE lease-wait budget across the whole batch rather than paying up to
    // LANE_WAITS.approvalPlacement per proposal serially — a full-batch worst case would otherwise
    // approach BULK_APPROVE_MAX_REQUESTS × 30s of pure waiting inside one HTTP request, well past
    // typical edge/proxy timeouts. Once the shared budget is exhausted, remaining calls in this
    // batch become try-once (waitMs 0) and return an honest per-proposal busy result immediately.
    const leaseDeadline = Date.now() + LANE_WAITS.approvalPlacement;

    const results = [];
    for (const id of proposalIds) {
      const row = rowsById.get(id);
      if (!row) continue;
      try {
        const result = await executeProposal(id, userId, {
          liveConfirmation:
            proposalExecutionMode(row, executionState.mode) === "broker/live" &&
            policy.requireTypedConfirmation !== false
              ? perProposalLiveConfirmation(row)
              : undefined,
          leaseWaitMs: Math.max(0, leaseDeadline - Date.now())
        });
        const placement = resolvePlacementOutcome(result);
        results.push({ proposalId: id, symbol: row.proposal.symbol, ...placement });
      } catch (error) {
        if (error instanceof LiveApprovalConfirmationError) {
          const placement = resolvePlacementOutcome({ status: "error", reasons: error.reasons });
          results.push({ proposalId: id, symbol: row.proposal.symbol, ...placement });
        } else {
          const reasons = [error instanceof Error ? error.message : "Failed to execute proposal."];
          const placement = resolvePlacementOutcome({ status: "error", reasons });
          results.push({
            proposalId: id,
            symbol: row.proposal.symbol,
            ...placement
          });
        }
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof LiveApprovalConfirmationError) {
      return NextResponse.json(
        { error: error.code, reasons: error.reasons, expectedText: error.expectedText },
        { status: 409 }
      );
    }
    const message = error instanceof Error ? error.message : "Failed to approve proposals.";
    return new NextResponse(message, { status: 400 });
  }
}
