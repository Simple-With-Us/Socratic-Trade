# 2026-06-20 - Execution, RAG, and LLM foundations

## Summary

- Implemented the first runtime slice from the architecture blueprint:
  tri-state execution semantics, deterministic bounded OpenAI request bodies,
  and tenant-safe RAG retrieval/storage hardening.
- Dashboard and backend language now distinguishes Mock/Local from Broker Paper
  and Broker Live, including Alpaca Paper as broker-hosted paper rather than the
  app's local simulator.

## Why

- The app previously overloaded "Paper mode" for local simulation and broker
  paper environments. That could confuse users and LLM prompts, especially once
  real Alpaca Paper routing is enabled.
- OpenAI request bodies needed a shared cap/sampling policy so Bull, Bear, Red
  Team, tuning, and post-mortem calls stay deterministic and bounded.
- Vector memory needed tenant guards so user-supplied metadata cannot spoof
  `userId`/`text`, and retrieval can safely combine a user's private context with
  shared public filings.

## Files

- `app/dashboard-client.tsx`
- `src/lib/db.ts`
- `src/lib/execution-mode.ts`
- `src/lib/llm-request.ts`
- `src/lib/post-mortem.ts`
- `src/lib/red-team.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/strategy.ts`
- `src/lib/vector-db.ts`
- `test/execution-mode.test.ts`
- `test/persistence-notification.test.ts`
- `test/post-mortem.test.ts`
- `test/red-team.test.ts`
- `test/strategy-tuning.test.ts`
- `test/vector-db.test.ts`
- `docs/architecture-blueprint.md`
- `docs/phase-7-strategy.md`
- `docs/phase-10-signals-learning-ui-v2.md`
- `docs/phase-11-multi-user.md`
- `PLAN.md`
- `STATUS.md`
- `docs/rollouts/2026-06-20-execution-rag-llm-foundations.md`

## Verification

- `npx vitest run test/vector-db.test.ts test/execution-mode.test.ts test/persistence-notification.test.ts test/strategy-tuning.test.ts test/red-team.test.ts` passed: 5 files, 29 tests.
- `npx vitest run test/post-mortem.test.ts test/vector-db.test.ts test/execution-mode.test.ts test/persistence-notification.test.ts test/strategy-tuning.test.ts test/red-team.test.ts` passed: 6 files, 30 tests.
- `npx tsc --noEmit` passed.
- `npm test` passed: 37 files, 261 tests.
- `npm run build` passed.
- `git diff --check` passed.
- `pm2 restart trading-codex` restarted the Codex preview on port 4101 after the build.
- `curl -sS -D - http://127.0.0.1:4101/api/health` returned `{"ok":true}`.
- `curl -sS -I http://127.0.0.1:4101/` returned `HTTP/1.1 200 OK`.
- In-app browser visual smoke on `http://127.0.0.1:4101/` confirmed the header/portfolio show `Mock/Local`, Settings -> Operate says `Mock/Local mode is active`, Base indexes / Additional Watchlist / Ignore List are visible, and the disabled broker transition path reads `Switch to Broker Mode` when no active connected account is selected.

## Follow-ups

- Complete synthetic trailing-stop storage/evaluator before wiring any automated
  exit placement.
- Add IRA/tax-account type storage and cross-account wash-sale prevention before
  making tax behavior account-aware.
- Add separate public/private Pinecone key or namespace routing if the app moves
  beyond the current shared-public plus user-filtered index design.
- Add a seeded Broker Paper UI smoke fixture so the visual check can verify
  `Broker Paper mode is active` without requiring live credentials.
