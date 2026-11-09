# Expert Guidance Consolidation

## Summary

- Added two stable entry-point docs for expert advice:
  - `docs/reviews/ui-expert-guidance.md`
  - `docs/reviews/cross-functional-expert-guidance.md`
- Preserved the original dated review and rollout notes as source evidence.
- Updated `STATUS.md` so future handoffs can find the consolidated guidance
  without searching every rollout.

## Why

Expert advice was split across dated review reports, rollout notes, and phase
docs. The UI/design guidance and the non-UI expert-panel guidance now each have
one durable document that captures source notes, durable standards, implemented
items, and open follow-ups.

## Files

- `STATUS.md`
- `docs/reviews/ui-expert-guidance.md`
- `docs/reviews/cross-functional-expert-guidance.md`
- `docs/rollouts/2026-06-19-expert-guidance-consolidation.md`

## Verification

- `npx tsc --noEmit` passed.
- `npm test` passed: 34 files, 252 tests.
- `npm run build` passed.
- `rm -rf .next && pm2 restart trading-codex` restarted the Codex preview after
  the build regenerated `.next`.
- `curl -sS -o /tmp/trading-codex-health-expert-guidance.json -w '%{http_code}\n' http://127.0.0.1:4101/api/health` returned `200`.
- `curl -sS -o /tmp/trading-codex-dashboard-expert-guidance-2.json -w '%{http_code} %{size_download}\n' http://127.0.0.1:4101/api/dashboard` returned `200 113460`.
- After the dashboard API warmed, identity-encoded root `GET /` returned
  `200 136048`; `HEAD /` returned `200`.
- `git diff --check` passed.

## Follow-ups

- Keep these docs current when a new expert review, panel, or platform audit
  changes product, UI, strategy, data, or ops guidance.
