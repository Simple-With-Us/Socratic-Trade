1. **Context & Objective**: 
   The application was suffering from severe performance degradation and periodic crash-loops due to Litestream OOMs (out of memory) stemming from a corrupted Backblaze B2 backup generation. Additionally, the dashboard was slow to load due to sequential data fetches from brokers. The objective of this rollout was to mitigate the Litestream crash loop with a generic disable marker and optimize the dashboard performance.

2. **Changes Made**: 
   - Added a generic `LITESTREAM_DISABLE_MARKER` (`.litestream-disabled`) check to the `scripts/coolify-prod-start.sh` boot script. This acts as a manual kill switch to run the application without Litestream replication during memory leak investigations or outages.
   - Refactored `getDashboardSnapshot` in `src/lib/dashboard.ts` to fetch broker accounts concurrently with the portfolio, positions, and orders when the target account number is known.

   Files touched:
   - `scripts/coolify-prod-start.sh`
   - `src/lib/dashboard.ts`

3. **Decisions & Trade-offs**: 
   - We opted for a generic Litestream disable marker rather than wiping the Backblaze B2 bucket immediately to give the owner the choice on when to perform the destructive action, while immediately stopping the crash loop affecting users.
   - For dashboard fetching, if `policy.accountNumber` is missing, we must still await `getAccounts` to resolve the fallback account number before fetching the portfolio. This is a known fallback path, but the fast path (known account number) now executes both blocks concurrently.

4. **Verification State**: 
   - Verified that `npm run build` and `npm test` passed locally.
   - Dropped the `.litestream-disabled` marker directly onto the production server's Docker volume using SSH, which ensures the next restart (like the one triggered by this deploy) will skip Litestream.
   - All tests pass: `npm run lint`, `npx tsc --noEmit`, `npm test` are green.

5. **Next Steps & Blockers**: 
   - Monitor the application stability and ensure no further OOM crashes occur.
   - Monitor dashboard load times for noticeable improvement.
   - Coordinate with the owner to wipe the corrupted B2 backup generation when ready.

6. **Zero-Code Findings**: 
   - Investigated the Litestream memory leak and confirmed it was due to a retry loop caused by checksum mismatches in the B2 generation uploads. Re-verified `litestream` version 0.5.12 was running.
