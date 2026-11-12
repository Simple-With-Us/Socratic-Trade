# FRED proxy fail-soft — Kody review follow-up (PR #4158)

## Context & Objective

PR #4158 (`fix/fred-proxy-failsoft`) adds FRED direct egress, `AbortError` proxy-leg classification, and a per-proxy-leg timeout so `fail_soft` can retry on direct before the caller's budget expires.  Kody left five open threads; this note records which were fixed in code vs intentionally left open.

## Changes Made

- **`dataSourceFetch`:** apply `PROXY_LEG_TIMEOUT_MS` only when the caller did **not** pass `init.signal`, so 6–12s provider lanes are not truncated at 3s on a slow-but-working residential proxy.
- **`createProxiedFetch`:** defer proxy-leg timer and caller-abort listener teardown until the response **body** finishes (wrapped `ReadableStream`), and forward caller abort through body reads via `AbortSignal.any` on the header phase plus body listeners.
- **`test/proxy-fetch.test.ts`:** regression that caller abort during proxied body consumption rejects.

Touched files:

- `src/lib/data-source-fetch.ts`
- `src/lib/proxy-fetch.ts`
- `test/proxy-fetch.test.ts`
- `docs/rollouts/2026-10-05-fred-proxy-kody-review.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- **Left open (not changed):** three Kody "critical" threads asking to replace `http://10.99.0.2:8888` in tests with `proxy.test`.  Owner directive: that address is the documented fleet default (`DEFAULT_RESIDENTIAL_PROXY_URL`) and is not a secret to hide in fixtures; threads stay open.
- **Left open:** Kody "integration tree" rule on the same test line — false positive for Cursor Cloud `/workspace`; no code change.
- **Stale pin check:** Usage-Monitor `main` already pins `congress-trading-shared` v2.7.1; no pin change on this PR.

## Verification State

```bash
npm run lint          # 0 errors (warnings only)
npx tsc --noEmit      # clean
npm test -- test/proxy-fetch.test.ts test/data-source-fetch.test.ts  # 32 passed
```

Full `npm test` / `npm run build` not re-run in this handoff slice (targeted tests + tsc + lint only).

## Next Steps & Blockers

- Owner or review seat: resolve Kody threads **4178839592** (perf) and **4178839731** (bug) after verifying the diff; leave **4178840036**, **4178840397**, **4178840614** (private IP in tests) open per owner policy.
- Do not merge until human review; do not force-ship.

## Zero-Code Findings

None beyond the thread disposition above.
