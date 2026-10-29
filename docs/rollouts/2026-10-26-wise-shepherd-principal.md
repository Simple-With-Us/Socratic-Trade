# ST Wise relay caller migration

## Context and changes

ST armer and shepherd use Wise App identity through existing Git Relay. No personal GH_PAT, SHEPHERD_TOKEN or gh-auth fallback remains in these callers. Relay repository access can cover all enumerated owned repositories; this consumer remains ST-specific.

The adapter reads dedicated Fleet-OPS prod /gr-front/wise-st using a purpose-scoped Infisical service token. It validates exact config and permissions, HTTPS origin, relay App/short-lived token, and GitHub viewer before consumer work. The consumer command receives only short-lived GH_TOKEN, not relay bearer or Infisical bootstrap. Shared armer mints in the actual job, not via secret job outputs. The pinned shared-workflow revision must contain the paired guard and job-local mint support before this caller change lands.

## Verification

`python3 scripts/test_wise_relay_exec.py` (11), principal startup selftest (7), existing in-flight/status-issue selftests, YAML parsing and bash syntax checks.

PR #4948 CI repair (2026-10-29): branch-protection gate test now asserts `use_wise_relay` / `WISE_RELAY_INFISICAL_TOKEN` instead of legacy `merge_token`; Sentry CI reporter observes `Wise relay read-only canary`.  Commands: `npx vitest run test/branch-protection-gate.test.ts test/sentry-ci-report-workflows.test.ts`, full verify gate locally.

## Adoption and blockers

No credential is in this change. GitHub merge-shepherd environment must contain WISE_RELAY_INFISICAL_TOKEN scoped read-only to the exact prod folder. Mac wrapper is a reviewed installation candidate, not installed by this PR; it requires an unattended qualified native Keychain purpose item. Preserve old storage/access until replacement is verified, but never resume personal writes as fallback. No native ship, manual deployment, OAuth change, global credential revocation or other-repo caller change.

Review repair: unused --github-env credential export removed entirely; exec-mode only. Null/malformed GraphQL data/viewer fails closed. Existing shared-workflow pin retained pending source compatibility qualification, not silently upgraded to a revision lacking Wise inputs. No rollout acceptance inferred.
