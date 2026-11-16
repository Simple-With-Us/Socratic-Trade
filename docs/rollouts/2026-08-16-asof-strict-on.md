# 2026-08-16 — VECTOR_ASOF_STRICT on

## 1. Context & Objective

Owner asked to enable fail-closed dated retrieval after the 13076/13076 epoch receipt.  Live desk (chat / Autopilot propose) still omits `asOf` and is unchanged.

## 2. Changes Made

- Infisical ST prod `/`: `VECTOR_ASOF_STRICT` was present as `off` (len=3).  Set to `on` (len=2, value_eq=on).  Project `39d93bb7-76f9-498c-8b50-a7def52e072f`.
- Coolify `socratic-app` (`<ST_COOLIFY_APP_UUID>`) restart queued as deployment `fwqascvivxvc7342hkw3aizk` (finished).  `https://socratictrade.com/api/health` returned 200.
- Admin dormant-features row: ready to enable; note describes on vs off.  Backlog row moved to live.

Touched:

- `src/lib/dormant-features.ts`
- `test/dormant-features.test.ts`
- `docs/FEATURE-ENABLEMENT-BACKLOG.md`
- This note, STATUS, PLAN, effort log

## 3. Decisions & Trade-offs

- Did not add a Coolify env copy.  Infisical is the runtime catalog.
- Did not change chat/live retrieval.  Those paths omit `asOf`.
- Did not re-run the Pinecone dry-run; the 2026-08-16 receipt still applies.

## 4. Verification State

- Infisical `has` after set: `present key=VECTOR_ASOF_STRICT len=2`, `value_eq=on`.
- Coolify restart finished; health 200.
- Targeted: `test/dormant-features.test.ts`.  Then `scripts/land.sh`.

## 5. Next Steps

Re-run `BACKFILL_DRY_RUN=1` after a large ingest burst.  Dated paths (backtest, lookahead, replay) now drop undated chunks if ingest later reintroduces them.
