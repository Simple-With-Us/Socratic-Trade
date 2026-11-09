import { getBrokerGateway } from "@/lib/broker";
import { getActiveConnectedAccount, getInternalSetting, getPolicy } from "@/lib/db";
import { deriveExecutionState } from "@/lib/execution-mode";
import { resolveRequestUserId } from "@/lib/request-user";
import { getLease } from "@/lib/scheduler-lease";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SCHEDULER_STALE_MS = 5 * 60_000;

function protectiveState(state: string | undefined): boolean {
  return state === "active" || state === "close_only" || state === "liquidating";
}

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const checks: Record<string, unknown> = {};
  const failures: string[] = [];

  let policy;
  try {
    policy = getPolicy(userId);
    checks.db = "ok";
  } catch (error) {
    checks.db = error instanceof Error ? error.message : "error";
    failures.push("db");
    return NextResponse.json({ ok: false, checks, failures }, { status: 503 });
  }

  const lastTick = getInternalSetting<string>("scheduler:lastTick");
  if (lastTick) {
    const ageMs = Date.now() - new Date(lastTick).getTime();
    checks.schedulerLastTick = lastTick;
    checks.schedulerAgeSeconds = Math.round(ageMs / 1000);
    if (ageMs > SCHEDULER_STALE_MS) {
      checks.schedulerStale = true;
      if (protectiveState(policy.systemState)) failures.push("scheduler_stale");
    }
  } else {
    checks.schedulerLastTick = null;
    if (protectiveState(policy.systemState)) failures.push("scheduler_missing");
  }

  // Scheduler lease state (additive; only meaningful when SCHEDULER_SINGLE_LEADER is on).
  // Never pushed to failures — lease absence does not indicate unreadiness.
  try {
    const lease = getLease();
    if (lease) {
      checks.schedulerLease = {
        owner: lease.owner,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        ageSeconds: Math.round(lease.ageMs / 1000),
        expired: lease.expired
      };
    } else {
      checks.schedulerLease = null;
    }
  } catch {
    // never let lease reporting break the readiness probe
  }

  const activeAccount = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccount);
  checks.executionMode = executionState.mode;
  checks.systemState = policy.systemState;
  checks.accountNumber = policy.accountNumber ?? null;
  checks.accountId = activeAccount?.id ?? null;
  checks.broker = activeAccount?.broker ?? policy.activeBroker ?? null;

  if (protectiveState(policy.systemState) && !policy.accountNumber) {
    failures.push("account_missing");
  }

  if (policy.accountNumber && executionState.submitsBrokerOrders) {
    try {
      const accounts = await getBrokerGateway(policy, userId).getAccounts();
      const selected = accounts.find((account) => account.accountNumber === policy.accountNumber);
      checks.selectedAccountAvailable = Boolean(selected);
      checks.selectedAccountAgenticAllowed = selected?.agenticAllowed ?? null;
      if (!selected) failures.push("selected_account_unavailable");
      if (selected && !selected.agenticAllowed) failures.push("selected_account_not_agentic_allowed");
    } catch (error) {
      checks.brokerAccountRead = error instanceof Error ? error.message : "error";
      failures.push("broker_unavailable");
    }
  }

  const ok = failures.length === 0;
  return NextResponse.json({ ok, checks, failures }, { status: ok ? 200 : 503 });
}
