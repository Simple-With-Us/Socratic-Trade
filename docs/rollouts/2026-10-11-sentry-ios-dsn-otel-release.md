# 2026-10-11 -- Socratic-Trade Sentry iOS DSN, OTel release, deploy latch

Branch `cursor/sentry-ios-dsn-spans-5fec`.  Fleet telemetry audit section C item 13.

## 1. Context & Objective

iOS Cocoa has been a no-op for about 30 days because TestFlight archive never received `SENTRY_DSN`.  About 32k Sentry spans in project `socratic-trade` have a null SDK name and no release; they are Langfuse OTel traces named `LLM Generation` (`gen_ai.embeddings` / `gen_ai` / `gen_ai.rerank` / `gen_ai.chat` / `default`).  Sentry Deploy was failing the 25-minute observation window during weekday RTH because Coolify refuses the image build until the evening drain.  `refresh-rag-snapshot` is not a Socratic-Trade workflow (FLEET-INFRA-DN lives on Fleet-OPS / AI-Fleet-Coordinator).

## 2. Changes Made

- TestFlight ship loads `SENTRY_DSN` from Infisical prod (same name Coolify already uses) and keeps GitHub Actions `secrets.SENTRY_DSN` as fallback.  The value is masked.  Never hardcoded.  `scripts/ios-fleet/ship-testflight.sh` already injects it into `xcodebuild` when set.
- iOS `releaseName` is now `com.socratictrade.ios@{CFBundleShortVersionString}+{CFBundleVersion}`.  Continuous profiling stays `lifecycle = .trace` at session sample 0.1 (sentry-cocoa 9).  Profiles cannot arrive until a ship injects the DSN.
- Runtime `Sentry.init` (server, edge, browser) sets `release` from `resolveSentryRelease()` -- the same 40-char SHA walk as `scripts/sentry-build-release.cjs`.
- Langfuse `NodeTracerProvider` now has an OTel resource (`service.name`, `service.version`, `sentry.release`) so those SDK-less `LLM Generation` spans carry the production SHA.
- Sentry Deploy skips the 25-minute poll when the weekday RTH latch or an image-noop would refuse Coolify (`SENTRY_DEPLOY_SKIP_REASON`).  The evening `RTH Deploy Latch` drain completion re-runs the reporter.
- `CRON_SCHEDULES` is unchanged and still matches every scheduled workflow in this repo.  A comment records that `refresh-rag-snapshot` must not be added here.

Touched files:

- `.github/workflows/ios-ship.yml`
- `.github/workflows/sentry-deploy.yml`
- `.github/workflows/sentry-ci-report.yml`
- `scripts/sentry-ci-report.py`
- `scripts/sentry-report-deploy.mjs`
- `scripts/sentry-report-deploy.node-test.mjs`
- `src/lib/sentry-release.ts`
- `src/lib/observability.ts`
- `sentry.server.config.ts`
- `sentry.edge.config.ts`
- `instrumentation-client.ts`
- `ios/SocraticTrade/SentryTelemetry.swift`
- `test/sentry-release.test.ts`
- `test/sentry-tunnel-middleware.test.ts`
- `test/ios-manual-signing.test.ts`
- `docs/ops-observability-security.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-10-11-sentry-ios-dsn-otel-release.md`

`docs/EFFORT-LOG.md` is archived (Linear is the system of record) and was not edited.

## 3. Decisions & Trade-offs

- No hardcoded DSN.  Infisical prod `SENTRY_DSN` is the intended source; the GitHub secret is only a fallback if Infisical is missing the key.
- Did not add a second Sentry span processor next to Langfuse.  Those spans already reach Sentry via the OTel bridge; stamping `sentry.release` / `service.version` is the minimal fix for "give them a release."  SDK name will stay empty for OTel-ingested rows.
- Did not retire Datadog LLM-obs/RUM (audit called that optional).
- Did not invent a `refresh-rag-snapshot` workflow in this repo.  Adding a `CRON_SCHEDULES` key for a workflow that does not exist fails `test/sentry-ci-report-workflows.test.ts`.
- Trading logic untouched.

## 4. Verification State

Commands actually run are recorded in the PR and in STATUS.md after the gate.

## 5. Next Steps & Blockers

- Jay: confirm Infisical prod (`socratic-trade`) has `SENTRY_DSN` (the iOS/server project DSN).  Optional fallback: repo Actions secret `SENTRY_DSN` with the same value.  `SENTRY_AUTH_TOKEN` is already required for dSYM upload and Sentry Deploy.
- Next TestFlight ship (ios-ship after this lands on main, or a manual `ios-ship.yml` dispatch) is what actually instruments devices.
- Continuous profiles: server already has `profileLifecycle: "trace"` + `@sentry/profiling-node`.  Confirm in Sentry after the next image deploy.  iOS profiles start after the DSN-injected ship.
- FLEET-INFRA-DN (`refresh-rag-snapshot`) is an AI-Fleet-Coordinator / Fleet-OPS job, not this repo.

## 6. Zero-Code Findings

- Sentry Explore (7d, `!has:sdk.name`, project `socratic-trade`): 13929 `gen_ai.embeddings`, 11539 `default`, 5109 `gen_ai`, 1056 `gen_ai.rerank`, 331 `gen_ai.chat`, all transaction `LLM Generation`, release null.  That string is not in this repo; it is Langfuse's generation trace name.
- Recent Sentry Deploy failures (e.g. run 38128828046) exited `Deployment not confirmed within the bounded observation window: Production has not deployed this CI revision or a successor` after 25 minutes during weekday RTH.  Later evening runs succeeded.
- No `refresh-rag-snapshot` workflow exists on Simple-With-Us/Socratic-Trade.  The same name lives in AI-Fleet-Coordinator and Fleet-OPS.
