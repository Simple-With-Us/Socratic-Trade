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
  /** Message of the expected ref tip.  The deployed latch reads HOTFIX from the
   * built HEAD, so a tip-only HOTFIX=1 ships at once and must age from commit. */
  tipCommitMessage?: string | null;
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
  // `||`, not `??`: a set-but-empty RTH_DEPLOY_LATCH_NOW must not shadow the
  // DEPLOY_FRESHNESS_LATCH_NOW pin and fall back to the wall clock.
  const raw = env.RTH_DEPLOY_LATCH_NOW?.trim() || env.DEPLOY_FRESHNESS_LATCH_NOW?.trim();
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`DEPLOY_FRESHNESS_LATCH_NOW is not a valid date: ${raw}`);
  }
  return parsed;
}

/** Hour and minute (UTC) of the scheduled RTH deploy drain cron. */
export const RTH_DRAIN_UTC_HOUR = 21;
export const RTH_DRAIN_UTC_MINUTE = 20;

/** The scheduled drain on the commit's UTC day (epoch ms). */
export function rthDrainUtcMs(at: Date): number {
  return Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
    RTH_DRAIN_UTC_HOUR,
    RTH_DRAIN_UTC_MINUTE
  );
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
    commitMessageRequestsHotfix(input.tipCommitMessage) ||
    envFlagEnabled(input.overrideEnv);

  let deployDueAnchorMs = commitMs;
  const latchReason: RthDeployLatchReason | "none" = latchAtCommit.reason;

  let insideLatchWindow = false;
  if (latchAtCommit.reason === "rth-blocked" && !hotfix) {
    const closeMs = regularSessionCloseUtcMs(commitAt);
    if (closeMs != null) {
      // The latch lifts at close, but the after-close drain
      // (.github/workflows/rth-deploy-latch.yml, 21:20 UTC weekdays) is what
      // ships the gap.  Start the grace at whichever comes later so an EDT or
      // early-close day does not page before the drain has run.
      deployDueAnchorMs = Math.max(closeMs, rthDrainUtcMs(commitAt));
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
      detail = `RTH latch lifted; within ${input.staleSeconds}s deploy grace after the after-close drain.`;
    } else {
      detail = `RTH latch lifted; undeployed longer than ${input.staleSeconds}s after the after-close drain.`;
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
  const tipMessage = env.DEPLOY_FRESHNESS_TIP_MESSAGE?.trim();
  return decideDeployFreshnessStaleness({
    now: latchNowFromEnv(env),
    oldestCommitEpochSec,
    oldestCommitMessage: message || undefined,
    tipCommitMessage: tipMessage || undefined,
    staleSeconds,
    hotfixEnv: env.HOTFIX,
    overrideEnv: env.RTH_DEPLOY_OVERRIDE
  });
}
