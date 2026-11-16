import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GUARDED_ROUTES = [
  ["app/api/admin/reindex-8k/route.ts", "reindex-8k", ["await reindexEightKDataset"]],
  ["app/api/admin/reindex-10k/route.ts", "reindex-10k", ["await refreshFilingBodies"]],
  ["app/api/admin/backtest-ic/route.ts", "backtest-ic", ["await buildFactorObservations", "await runWalkForwardOOS"]],
  ["app/api/admin/tuning-dry-run/route.ts", "tuning-dry-run", ["await dryRunAutonomousWeightTuning"]],
  ["app/api/admin/congress-score-eval/route.ts", "congress-score-eval", ["await buildCongressScoreObservations"]],
  ["app/api/admin/congress-share/route.ts", "congress-share", ["await runCongressDailyShare"]],
  ["app/api/admin/refresh-websource/route.ts", "refresh-websource", ["await refreshCongress", "await refreshEightK"]],
  ["app/api/admin/robinhood-probe/route.ts", "robinhood-probe", ["await Promise.allSettled"]]
] as const;

describe("expensive admin route guard wiring", () => {
  for (const [path, operation, workMarkers] of GUARDED_ROUTES) {
    it(`${path} authenticates and enters its named guard before expensive work`, () => {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      const authIndex = source.indexOf("requireAdmin(request");
      const guardIndex = source.indexOf(`withAdminOperationGuard(request, "${operation}"`);

      expect(authIndex).toBeGreaterThanOrEqual(0);
      expect(guardIndex).toBeGreaterThan(authIndex);
      for (const marker of workMarkers) {
        expect(source.indexOf(marker)).toBeGreaterThan(guardIndex);
      }
    });
  }
});
