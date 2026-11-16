# Rollout: Migrate EOD Quote History Cache to SQLite

1. **Context & Objective**: 
   The application previously relied on a flat-file JSON cache (`data/history-5y/` and `data/massive-history/`) to cache historical End-of-Day (EOD) OHLC quotes fetched from network sources (Tradier, Marketstack, Tiingo, etc.). This mechanism was silent-failing and caused test failures. The goal was to fully transition to a local SQLite-backed table (`history_cache_eod`) to persist EOD bars for fast replay during live strategy runs and avoid expensive API network loops.

2. **Changes Made**:
   - Created a new SQLite table `history_cache_eod` in `src/lib/db.ts` to store EOD OHLCV bars by ticker and date.
   - Replaced flat file operations with `src/lib/history-cache.ts` containing SQLite implementations for upserting and fetching history (`upsertHistoryCacheEod`, `fetchHistoryCacheEod`).
   - Edited `src/lib/history.ts` to substitute `fetchLocalFlatFileHistory` with `fetchHistoryCacheEod` within the provider cascade, and added an upsert mechanism to write back missing history after pulling it from upstream providers.
   - Updated `test/history.test.ts` to test SQLite database seeding and retrieval instead of flat file mocks.
   - Rebuilt `better-sqlite3` to align the Node versions.

3. **Decisions & Trade-offs**:
   - Dropped the legacy `fetchLocalFlatFileHistory` utility in favor of the new database-backed implementation.
   - SQLite cache is written seamlessly after fetching from any source (except itself), keeping the rest of the app decoupled from persistence specifics.

4. **Verification State**:
   - Commands run:
     - `npm rebuild` (Fixed `better-sqlite3` Node version mismatch)
     - `npm test test/history.test.ts`
     - `npx tsc --noEmit && npm run build`
   - Build status:
     - 22/22 unit tests passing for `test/history.test.ts`. Build verification in progress.

5. **Next Steps & Blockers**:
   - No code blockers. The next step is for the user to review the changes and address the remaining OpenRouter tasks if any still persist, given the conversation switches.
