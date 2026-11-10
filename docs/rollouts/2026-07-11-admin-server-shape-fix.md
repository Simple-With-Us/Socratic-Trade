# 2026-07-11 — Admin server Hetzner response-shape crash fix

## Summary

- Fixed the production `/admin/server` React error #31 caused by rendering Hetzner response
  objects as text.
- Normalized `server_type.name`, `public_net.ipv4.ip`, and current `location.name` at the API
  boundary while retaining compatibility with earlier flattened and datacenter shapes.
- Added explicit provider-shape warnings and a client-side final guard that renders a diagnostic
  string rather than passing malformed runtime JSON to React.
- Normalized Coolify resource rows before calling string methods/rendering their fields.
- Removed fabricated local resource rows and metric histories. The unconfigured local path reports
  its real runtime metadata, while configured production failures leave remote fields unavailable
  instead of substituting local-process statistics or hardcoded host identity.
- Provider network, HTTP, and JSON failures now return a preserved 502 degraded envelope. The
  client renders any verified partial data and visibly labels production as degraded.
- Replaced the metrics parser's `any` boundary with checked record/tuple parsing; malformed samples
  are omitted with a warning instead of becoming false zero readings.

## Why

The original test represented `server_type` as `"cx33"` and omitted `public_net`, but Hetzner's
real API returns `server_type: { name: "..." }` and `public_net.ipv4: { ip: "..." }`. The route
forwarded those objects as `hostInfo.serverType` and `hostInfo.ip`; JSX then attempted to render
them and production crashed with React minified error #31.

## Files

- `app/api/admin/server-metrics/route.ts` — checked provider fetches with deadline/status/JSON
  receipts, normalized host payload, checked metrics parsing, and explicit degraded responses.
- `app/admin/server/server-metrics-client.tsx` — defensive display-string guard and visible
  provider warning receipt.
- `src/lib/server-metrics-shapes.ts` — pure checked provider-shape parsers shared by the route
  and regression tests, including string-only Coolify resource normalization.
- `test/server-metrics.test.ts` — current Hetzner-shaped fixture plus malformed-provider,
  malformed-sample, rejected-network, 401, and 403 regression coverage.
- `STATUS.md` — current fix status and next action.
- `docs/EFFORT-LOG.md` — branch reservation and in-progress state.
- `docs/rollouts/2026-07-11-admin-server-shape-fix.md` — this note.

## Verification

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci --no-audit --no-fund` — passed; 760 lockfile
  packages installed in the isolated worktree.
- `npx vitest run test/server-metrics.test.ts` — passed, 1 file / 6 tests.
- `npx eslint app/api/admin/server-metrics/route.ts app/admin/server/server-metrics-client.tsx src/lib/server-metrics-shapes.ts test/server-metrics.test.ts`
  — passed with 0 errors and one pre-existing `react-hooks/set-state-in-effect` warning at
  `server-metrics-client.tsx:112`.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint` — passed with 0 errors / 376 warnings.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test` — passed, 318 files / 3,491 tests.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build` — passed. Next.js emitted the existing
  Sentry Edge Runtime warning for `process.features` and the middleware deprecation warning.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh` — passed after removing only a
  corrupt ignored `.next/dev` generated cache left by the stopped dev server: typecheck clean,
  318 files / 3,491 tests passed, build clean, branch pushed, READY PR #1400 opened.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run dev -- --port 4301`; `curl` checks returned
  HTTP 200 for `/admin/server` and `/api/admin/server-metrics`. The API returned real Darwin host
  metadata plus empty `resources` and empty metric arrays with no provider credentials configured.
- In-app Browser initialization returned `No browser is available`, so a rendered interaction and
  console-log check could not be completed in this environment. No Playwright substitute was used.
- `git diff --check` — passed.

The initial dependency attempt before the serialized gate was killed with exit 137 and a temporary
lower-memory install omitted `@jaywedgeworth22/congress-trading-shared`. The clean Node 24 lockfile
install above repaired the isolated worktree, and the complete verification quartet then passed.

Post-PR integration receipt: after `origin/main` advanced through #1397 and #1399, a manual
`git merge --no-commit --no-ff origin/main` completed without textual conflicts. Both sides had
changed only `STATUS.md` and `docs/EFFORT-LOG.md` in common; Git retained both independently added
sections. No source file in this fix overlapped with the incoming source changes. Verification,
commit, and push were intentionally deferred while another lane held the serialized human-tree gate.

Current-main refresh receipt: `origin/main@8fca436d` merged without source conflicts. Adversarial
review found that provider failures still impersonated a healthy production host, malformed samples
became zero, and Hetzner's current response uses `location.name` after the datacenter deprecation.
All three findings are fixed. The first post-merge typecheck failed because this older worktree's
`node_modules` predated current-main's tracked `ts-morph` dependency; a clean locked install added
767 packages, after which the full ordered gate passed:

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/server-metrics.test.ts` — passed,
  1 file / 7 tests.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint app/api/admin/server-metrics/route.ts app/admin/server/server-metrics-client.tsx src/lib/server-metrics-shapes.ts test/server-metrics.test.ts`
  — passed with 0 errors / 0 warnings.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci --no-audit --no-fund` — passed, 767 locked
  packages installed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint` — passed with 0 errors / 405 inherited
  warnings.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — passed after the clean install.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test` — passed, 325 files / 3,608 tests.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build` — passed with the existing Sentry Edge
  Runtime and middleware-deprecation warnings.
- `git diff --check` — passed.

## Follow-ups

- Refresh READY PR #1400 through `scripts/land.sh`. Do not merge or enable auto-merge.
- Render-check `/admin/server` through the in-app Browser when a Browser backend is available.
- No `PLAN.md` change: this is a production bug fix within the existing admin metrics scope, not
  a roadmap or approach change.
