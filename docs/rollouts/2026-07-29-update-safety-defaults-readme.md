# Update Safety Defaults in README

1. **Context & Objective**: The `## Safety Defaults` section in `README.md` contained outdated fixed dollar caps ($10 per order, $500 daily notional) from early project phases.

2. **Changes Made**:
   - Updated `README.md` to document the current `DEFAULT_POLICY` settings: 5% NAV order cap, 20% NAV daily notional cap, 25% max symbol exposure, 80% max gross exposure (20% cash buffer), 10 daily opening orders cap, 120s quote staleness gate, 10% entry price drift limit, 5% ADV cap, and system state `halted` kill switch.
   - Updated `docs/EFFORT-LOG.md` and `docs/rollouts/`.

3. **Decisions & Trade-offs**: None. Pure documentation update to align README with live policy defaults.

4. **Verification State**:
   - `git diff README.md` verified against `src/lib/defaults.ts`.

5. **Next Steps**:
   - Land via `land.sh`.
