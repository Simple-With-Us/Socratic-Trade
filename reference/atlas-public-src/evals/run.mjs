// evals/run.mjs — CI entrypoint for the prompt-eval gate. Exits non-zero on any failure.
import { getMarketDataProvider } from '../apps/bff/src/providers/marketData.mjs';
import { config } from '../apps/bff/src/config.mjs';
import { makeOrchestrator } from '../apps/bff/src/orchestrator.mjs';
import { accountSnapshot } from '../apps/bff/src/accounts/registry.mjs';
import { runGolden } from './golden.mjs';

const orchestrate = makeOrchestrator({ marketData: getMarketDataProvider(config) });
const accountPositions = async (userId) => (await accountSnapshot(userId)).positions;

const { passed, failed, results } = await runGolden(orchestrate, accountPositions);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '\n      ' + r.errors.join('; ')}`);
console.log(`\nprompt-eval gate: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
