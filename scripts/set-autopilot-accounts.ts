#!/usr/bin/env npx tsx
/**
 * Arm named accounts as Autopilot (systemState=active + strategyAuthority=decide)
 * and enable auto-resume-on-boot so the next deploy does not halt them.
 *
 * Default is dry-run.  Pass --apply to write.
 *
 * Usage:
 *   npx tsx scripts/set-autopilot-accounts.ts
 *   npx tsx scripts/set-autopilot-accounts.ts --apply
 *
 * Never prints secrets or tokens.
 */
import { listConnectedAccounts, listUsers, peekPolicy, setPolicy } from "../src/lib/db";
import { getAutoResumeOnBoot, setAutoResumeOnBoot } from "../src/lib/db-settings";
import { autonomyStatusLabel } from "../src/lib/autonomy-labels";

const TARGET_LABELS = ["Roth IRA", "Alpaca Paper", "Tradier Sandbox", "Sandbox"] as const;

function parseArgs(argv: string[]): { apply: boolean } {
  return { apply: argv.includes("--apply") };
}

function isTargetLabel(label: string): boolean {
  const n = label.trim().toLowerCase();
  return TARGET_LABELS.some((wanted) => wanted.toLowerCase() === n || n === "tradier sandbox");
}

async function main(): Promise<void> {
  const { apply } = parseArgs(process.argv.slice(2));
  const users = listUsers();
  if (users.length === 0) {
    console.log("No users found.");
    process.exit(1);
  }

  let matched = 0;
  for (const userId of users) {
    const resume = getAutoResumeOnBoot(userId);
    console.log(`user=${userId} autoResumeOnBoot=${resume}`);
    if (apply && !resume) {
      setAutoResumeOnBoot(userId, true);
      console.log("  enabled autoResumeOnBoot");
    }

    for (const account of listConnectedAccounts(userId)) {
      if (!isTargetLabel(account.label)) continue;
      matched += 1;
      const before = peekPolicy(userId, account.id);
      const from = autonomyStatusLabel(before.systemState, before.strategyAuthority);
      console.log(
        `  ${account.label} (${account.broker}/${account.environment}) ${from} authority=${before.strategyAuthority} state=${before.systemState}`
      );
      if (!apply) continue;
      setPolicy(
        { ...before, systemState: "active", strategyAuthority: "decide" },
        userId,
        account.id
      );
      const after = peekPolicy(userId, account.id);
      console.log(`    -> ${autonomyStatusLabel(after.systemState, after.strategyAuthority)}`);
    }
  }

  if (matched === 0) {
    console.log("No matching accounts (Roth IRA / Alpaca Paper / Tradier Sandbox).");
    process.exit(1);
  }
  if (!apply) {
    console.log("Dry-run only.  Re-run with --apply to write Autopilot + auto-resume.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
