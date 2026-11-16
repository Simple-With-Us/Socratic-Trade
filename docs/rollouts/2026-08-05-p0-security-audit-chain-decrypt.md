# 2026-08-05 — P0 security residual (audit chain + decrypt reject plaintext)

## Context & Objective
Next tranche after activity-audit sweep: close remaining **P0 Security (#1159)** and document
already-landed P0/P1 items so effort-board issues stop lying.

## Changes Made
### Implemented (this PR)
1. **P0-5** — `decryptValue` rejects non-envelope plaintext (returns `""`). Migration still
   re-encrypts leftover plaintext via `isEncryptedValue` + `encryptValue`. OAuth path keeps
   legacy/no-key plaintext loadable via `decryptStoredTokens` + `isEncryptedValue` gate.
2. **P0-4** — Per-user tamper-evident audit hash chain: schema v67 columns `chain_hash` /
   `prev_chain_hash`; `audit()` links tip→new via SHA-256 material; `verifyAuditChain(userId)`.

### Already on main (verified, no code change)
- P0-1 rate-limit `/api/chat` + `/api/scan` (`enforceRateLimit`)
- P0-2 RH OAuth encrypt-at-rest (`mcp-oauth` + `encryptValue`)
- P0-3 constant-time admin token (`timingSafeEqualStr`)
- P1-1/2 dashboard fill prefetch + `getProposalsByIds` batching
- P1-3 `UNIFIED_FEED_MAX_GROUPS`, P1-4 sqlite pragmas, P1-5/6/7 case-write + crashed-run + due_jobs

## Files
- `src/lib/db-api-keys.ts`, `src/lib/mcp-oauth.ts`, `src/lib/db.ts`
- `test/encryption-key-guard.test.ts`, `test/security-oauth-token-encryption.test.ts`
- `test/audit-chain.test.ts`, `test/persistence-hardening.test.ts` (schema pin 67)
- `docs/EFFORT-LOG.md`

## Verification
```bash
npx vitest run test/encryption-key-guard.test.ts test/security-oauth-token-encryption.test.ts \
  test/audit-chain.test.ts test/persistence-hardening.test.ts
# 44 pass
```

## Next
- P1-8 agent-not-running receipts, P1-9 money-path fault-injection
- P2 ops verifications still listed on board
- Owner-gated items unchanged (#1324, dormant features, exit strategy B/C, SEC/RAG corpus)
