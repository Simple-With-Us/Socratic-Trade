#!/usr/bin/env npx tsx
// Fail a Coolify image build when:
//   exit 2 = weekday US equity RTH without HOTFIX=1 / RTH_DEPLOY_OVERRIDE=1
//   exit 3 = docs-only / image-noop (would not change the running image)
// Exit 0 = allow the rebuild.  Exit 1 = usage error.
// Runs BEFORE npm ci so a no-op like #2811 dies in seconds, not ~30 minutes.
// Keep this at build time — never call it from coolify-prod-start.sh.

import { execSync } from "node:child_process";
import {
  decideRthDeployLatchFromEnv,
  describeRthDeployLatchDecision
} from "../src/lib/rth-deploy-latch";

function readGitLog(): string | undefined {
  try {
    const message = execSync("git log -1 --pretty=%B", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return message.trim() ? message : undefined;
  } catch {
    return undefined;
  }
}

// Wrapped in an async IIFE rather than using top-level await, and that is load-bearing.
// The Dockerfile runs this at line 53, BEFORE `COPY package.json` at line 54 -- deliberately,
// so a docs-only no-op dies in seconds instead of after a ~30 minute `npm ci`.  But that means
// tsx sees no package.json, cannot read our `"type": "module"`, and falls back to a CJS
// transform, where a top-level await is a hard error:
//
//   ERROR: Top-level await is currently not supported with the "cjs" output format
//
// It works locally (package.json is present) and fails only inside the image, which is why it
// reached production and broke EVERY deploy from 2026-08-21T05:07Z onward while the running
// container kept serving stale code.  Do not "simplify" this back to a top-level await, and do
// not fix it by moving the package.json COPY earlier -- that would give up the fast-fail
// ordering this script exists for.
async function main(): Promise<void> {
  const decision = await decideRthDeployLatchFromEnv(process.env, readGitLog);
  const line = describeRthDeployLatchDecision(decision);
  if (decision.allowed) {
    console.log(line);
    process.exit(0);
  }
  console.error(line);
  process.exit(decision.reason === "image-noop" ? 3 : 2);
}

main().catch((err) => {
  // A crash here must not silently allow the build: exit 1 is the documented usage-error code.
  console.error("[rth-deploy-latch] assertion crashed:", err);
  process.exit(1);
});
