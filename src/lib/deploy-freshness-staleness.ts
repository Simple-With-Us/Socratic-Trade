// Deploy-freshness watchdog: age undeployed main commits with the same weekday
// RTH latch calendar as scripts/assert-rth-deploy-latch.ts (via evaluateRthDeployLatch).

import { regularSessionCloseUtcMs } from "./market-calendar";
import {
  commitMessageRequestsHotfix,
  envFlagEnabled,
  evaluateRthDeployLatch,
  type RthDeployLatchReason
} from "./rth-deploy-latch";

export type DeployFreshnessStalenessVerdict = "in-flight" | "stale";

export type DeployFreshnessStalenessInput = {
  now?: Date;
  oldestCommitEpochSec: number;
  oldestCommitMessage?: string | null;
  staleSeconds: number;
  hotfixEnv?: string | null;
  overrideEnv?: string | null;
};

export type DeployFreshnessStalenessDecision = {
  verdict: DeployFreshnessStalenessVerdict;
  /** Seconds since the effective deploy-due anchor (latch lift or commit). */
  effectiveAgeSeconds: number;
  /** Seconds since the commit timestamp (ignoring the latch). */
  rawCommitAgeSeconds: number;
  /** When the deploy clock starts for this gap (epoch ms). */
  deployDueAnchorMs: number;
  latchReason: RthDeployLatchReason | "none";
  detail: string;
};

function latchNowFromEnv(env: Record<string, string | undefined>): Date {
  const raw = env.RTH_DEPLOY_LATCH_NOW?.trim() ?? env.DEPLOY_FRESHNESS_LATCH_NOW?.trim();
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`DEPLOY_FRESHNESS_LATCH_NOW is not a valid date: ${raw}`);
  }
  return parsed;
}

export function decideDeployFreshnessStaleness(
  input: DeployFreshnessStalenessInput
): DeployFreshnessStalenessDecision {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const commitMs = input.oldestCommitEpochSec * 1000;
  const commitAt = new Date(commitMs);
  const rawCommitAgeSeconds = Math.max(0, Math.floor((nowMs - commitMs) / 1000));

  const latchAtCommit = evaluateRthDeployLatch({
    now: commitAt,
    hotfixEnv: input.hotfixEnv,
    overrideEnv: input.overrideEnv,
    commitMessage: input.oldestCommitMessage
  });

  const hotfix =
    envFlagEnabled(input.hotfixEnv) ||
    commitMessageRequestsHotfix(input.oldestCommitMessage) ||
    envFlagEnabled(input.overrideEnv);

  let deployDueAnchorMs = commitMs;
  const latchReason: RthDeployLatchReason | "none" = latchAtCommit.reason;

  let insideLatchWindow = false;
  if (latchAtCommit.reason === "rth-blocked" && !hotfix) {
    const closeMs = regularSessionCloseUtcMs(commitAt);
    if (closeMs != null) {
      deployDueAnchorMs = closeMs;
      insideLatchWindow = nowMs < closeMs;
    }
  }

  const effectiveAgeSeconds = insideLatchWindow
    ? 0
    : Math.max(0, Math.floor((nowMs - deployDueAnchorMs) / 1000));
  const stale = !insideLatchWindow && effectiveAgeSeconds >= input.staleSeconds;
  const verdict: DeployFreshnessStalenessVerdict = stale ? "stale" : "in-flight";

  let detail: string;
  if (latchAtCommit.reason === "rth-blocked" && !hotfix) {
    if (insideLatchWindow) {
      detail =
        "Undeployed commit landed during weekday RTH; Coolify build latch still active until session close.";
    } else if (verdict === "in-flight") {
      detail = `RTH latch lifted; within ${input.staleSeconds}s deploy grace after session close.`;
    } else {
      detail = `RTH latch lifted; undeployed longer than ${input.staleSeconds}s after session close.`;
    }
  } else if (verdict === "in-flight") {
    detail = `Within ${input.staleSeconds}s since commit (no RTH latch on this gap).`;
  } else {
    detail = `Undeployed longer than ${input.staleSeconds}s since commit (no RTH latch on this gap).`;
  }

  return {
    verdict,
    effectiveAgeSeconds,
    rawCommitAgeSeconds,
    deployDueAnchorMs,
    latchReason,
    detail
  };
}

export function decideDeployFreshnessStalenessFromEnv(
  env: Record<string, string | undefined> = process.env
): DeployFreshnessStalenessDecision {
  const oldestRaw = env.DEPLOY_FRESHNESS_OLDEST_EPOCH?.trim() ?? "";
  const staleRaw = env.DEPLOY_FRESHNESS_STALE_SECONDS?.trim() ?? "3600";
  const oldestCommitEpochSec = Number.parseInt(oldestRaw, 10);
  const staleSeconds = Number.parseInt(staleRaw, 10);
  if (!Number.isFinite(oldestCommitEpochSec) || oldestCommitEpochSec <= 0) {
    throw new Error("DEPLOY_FRESHNESS_OLDEST_EPOCH must be a positive integer (unix seconds).");
  }
  if (!Number.isFinite(staleSeconds) || staleSeconds < 0) {
    throw new Error("DEPLOY_FRESHNESS_STALE_SECONDS must be a non-negative integer.");
  }

  const message = env.DEPLOY_FRESHNESS_OLDEST_MESSAGE?.trim();
  return decideDeployFreshnessStaleness({
    now: latchNowFromEnv(env),
    oldestCommitEpochSec,
    oldestCommitMessage: message || undefined,
    staleSeconds,
    hotfixEnv: env.HOTFIX,
    overrideEnv: env.RTH_DEPLOY_OVERRIDE
  });
}
