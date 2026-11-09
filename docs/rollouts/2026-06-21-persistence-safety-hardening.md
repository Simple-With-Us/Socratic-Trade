# 2026-06-21 — Persistence & safety hardening (migration framework + money/data-loss fixes)

## Summary

Items #2 + #3 from the post-fix "what's left" re-audit
(`docs/reviews/2026-06-20-failure-mode-brainstorm.md`). One reviewed PR: a
`PRAGMA user_version` migration framework plus four S-effort money/data-loss
fixes. (Branch protection — roadmap #1 — was already configured as a ruleset;
CI workflow activation is a separate PR.)

Rebuilt onto current `main` after the `db.ts` god-file split (encryption now in
`db-api-keys.ts`; `db.ts` is the thin core that re-exports the split modules) and
the `next 15→16` / `zod 3→4` deps bump.

## Changes

- **Migration framework (`src/lib/db.ts` core).** `getDb()` calls
  `applyVersionedMigrations()` after the idempotent `migrate()` baseline.
  `runMigrations(db, migrations, baseline)` runs migrations whose version exceeds
  `PRAGMA user_version`, ascending, each in a transaction that bumps the version
  atomically; `SCHEMA_BASELINE = 1` stamps existing/fresh DBs. `MIGRATIONS` is
  empty for now — the **next** schema change goes there (versioned/ordered/
  stamped) instead of another unversioned ALTER. Adds `getSchemaVersion()`.
- **ENCRYPTION_KEY fail-fast (`src/lib/db.ts` core).** `assertEncryptionKeyAvailable()`
  (called in `getDb()`) throws at boot when the key is the ephemeral random
  fallback AND the DB holds AES-GCM ciphertext (`hasEncryptedCredentials()`),
  instead of silently decrypting stored creds to `''`. `ephemeral` is read from
  `process.env` at call time (robust to `.env.local` load order); no-ops under
  test / with a real key. Kept in the core file (queries `connected_accounts`
  directly) to avoid a circular import with `db-api-keys`.
- **No fabricated `$100` (`src/lib/alpaca.ts`).** Pure `estimateReviewNotional`:
  `dollarAmount`, else `quantity * (limit ?? stop ?? quote)`; when no price is
  determinable it returns `Number.MAX_SAFE_INTEGER` + an alert so an un-sizable
  **opening** order is blocked (fail-closed) rather than counting a $50k buy as
  $10k. `getEquityQuotes` now logs the swallowed error instead of returning `{}`
  silently.
- **Side-aware universe/blocklist gate (`src/lib/policy.ts`).** The check applies
  to **opening** trades only — a `sell`/`cover` exit is never blocked for being
  out-of-universe / blocklisted.
- **Synthetic-stop live exits → `pending_reconciliation` (`src/lib/synthetic-stops.ts`).**
  Live fills are provisional at the quote price and reconciled to the real broker
  fill (matched on `brokerOrderId`); paper/test fills stay final.

## Tests

- `test/persistence-hardening.test.ts` — `runMigrations`, the encryption boot
  guard, `estimateReviewNotional`, and the policy universe exit-gate.
- `test/synthetic-stops.test.ts` — added a LIVE stop exit → `pending_reconciliation`.

## Verification

Isolated worktree off `origin/main` (`8cf6125`), fresh `npm ci`
(next 16.2.9 / zod 4.4.3):

- `npx tsc --noEmit` — clean
- `npm test` — all pass (incl. new)
- `npm run build` — green

## Follow-ups (same roadmap, deferred)

- First migration on this framework: `fill_events` `UNIQUE(proposal_id, source)`
  idempotency (dedupe historical rows first).
- FK enforcement, transactional fill+snapshot writes, shared `llmFetch()` timeout,
  scheduler cadence rehydrate.
- Synthetic-stop `FillSource` mislabel (`'live'` for Alpaca *paper*) →
  `deriveExecutionState`.
- Process: give the autonomous agents a separate non-admin GitHub identity so a
  "require review" rule becomes enforceable without deadlock.
