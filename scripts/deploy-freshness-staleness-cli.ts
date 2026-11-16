#!/usr/bin/env npx tsx
// JSON line for scripts/alert-deploy-freshness.sh — shares the RTH deploy latch calendar.

import { decideDeployFreshnessStalenessFromEnv } from "../src/lib/deploy-freshness-staleness";

async function main(): Promise<void> {
  const decision = decideDeployFreshnessStalenessFromEnv(process.env);
  const payload = {
    verdict: decision.verdict,
    effectiveAgeSeconds: decision.effectiveAgeSeconds,
    rawCommitAgeSeconds: decision.rawCommitAgeSeconds,
    deployDueAnchorMs: decision.deployDueAnchorMs,
    latchReason: decision.latchReason,
    detail: decision.detail
  };
  console.log(JSON.stringify(payload));
}

main().catch((err) => {
  console.error("[deploy-freshness-staleness] crashed:", err);
  process.exit(1);
});
