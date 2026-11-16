# Admin server panel reliability

## Scope

Bounded repair of `/admin/server` and `/api/admin/server-metrics`. No Cloudflare, Hetzner, Coolify, deployment, or production-data state has been changed during implementation.

## Behavior

- Hetzner and Coolify are configured and queried independently. Partial configuration is explicit and remote target data is never replaced with local process telemetry.
- Provider errors return HTTP 200 degraded JSON while preserving fields from successful provider calls. Missing fields remain absent and render as unavailable.
- Hetzner network parsing supports current `network.*.bandwidth.in` and `.out` names while retaining `.rx` / `.tx` compatibility.
- Hetzner aggregate CPU is divided by a positive core count from server metadata (or Coolify metadata fallback). Without a verified core count, CPU samples are omitted with a warning.
- A module-level one-entry cache uses a 120-second TTL and single-flight refresh. Total outages retry after 30 seconds and can serve the last successful snapshot for at most 10 minutes; `asOf`, cache age, and stale state are exposed to the client.
- Provider responses are streamed through a 512 KiB cap. Missing or non-object Hetzner metric envelopes are rejected before success accounting; a partial refresh retains the prior good metric series and explicitly marks it stale.
- The panel validates successful response envelopes, retains and marks previous data stale after malformed or failed refreshes, and distinguishes local, remote, degraded, and stale states. It displays the snapshot timestamp under the coordinated `Server Stats` title. `SERVER_METRICS_TARGET_ENVIRONMENT=production` is the only way to label a remote target as production; `NODE_ENV` controls local-runtime fallback only.

## Verification

- `npm test -- --run test/server-metrics.test.ts`: 19 tests passed after current-main reconciliation and the bounded-warning review fix.
- Independent adversarial review: no P0-P2; its P3 full-snapshot regression request is covered.
- `npm test`: final serialized exact-tree rerun pending. An earlier pre-hardening 412-file / 4,800-test run passed; a later concurrent run was interrupted after unrelated timeout flakes while multiple agents were violating the shared full-gate serialization rule.
- `tsc --noEmit`: passed.
- `eslint app/api/admin/server-metrics/route.ts app/admin/server/server-metrics-client.tsx src/lib/server-metrics-runtime.ts src/lib/server-metrics-shapes.ts test/server-metrics.test.ts`: passed.
- `npm run build`: final exact-tree rerun pending; the pre-hardening Next.js 16.2.10 webpack production build passed.
- `git diff --check`: passed.

The prescribed in-app Browser could not start because its Node runtime reported `No such file or directory (os error 2)`. No Playwright fallback was substituted without owner authorization; authenticated visual QA remains a release receipt to obtain when that runtime is available.

## Release state

Committed on `codex/socratic-infra-panel-reliability` for review. Final serialized gate, production target labeling, push, PR, merge, deploy, and live revision verification remain pending.
