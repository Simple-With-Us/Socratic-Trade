# 2026-08-01 — Codex external-review remediation (MONET)

Branch `monet/codex-review-remediation`, worktree `~/apps/trading-monet`.

## 1. Context & Objective

The owner supplied a 30-finding external review from Codex ("30 material fixes or
improvements", no confirmed P0) and asked for the issues to be resolved, plus anything
else worth fixing. The review was written against `6c179a3f`; current `main` is
`88e614d7`, so part of the job was separating what is still true from what has already
been fixed or was never right.

Every finding was re-derived against current `main` before any code was written: a
6-cluster triage fan-out, then an independent adversarial verifier per claimed defect
instructed to default to *refuted* when it could not confirm the claim by reading the
code. 31 agents, 0 errors.

**Triage outcome: 15 confirmed REAL, 9 refuted, 6 not-real.** The refutations matter as
much as the fixes — several findings describe deliberate, documented design.

## 2. Changes Made

### Security — CSP report collector (finding 25, CONFIRMED)

`app/api/csp-report/route.ts` is public and unauthenticated by design (browsers POST
violation reports without cookies). Its body cap was defeatable three separate ways, and
all three were live:

- It called `await request.text()` and *then* checked the length — the whole body was
  materialized before any cap applied, so the real bound was available memory.
- Its only pre-check trusted `Content-Length`, which is optional (chunked encoding omits
  it) and attacker-controlled.
- It measured `String.length` — UTF-16 code units — so a 16k-"character" cap admitted
  ~4x that many bytes of multi-byte UTF-8.

Now reads the body off `request.body` as a stream, counting **bytes**, and cancels the
reader the moment the cap is crossed. The pre-existing test only exercised the
*lying-Content-Length* path with a 100-byte body, so it passed for the wrong reason; four
tests were added covering no-Content-Length, under-declared Content-Length, the
byte-vs-code-unit distinction, and a multi-byte body that legitimately fits.

### Client/server bundle boundary (finding 4, CONFIRMED)

`app/console/lib/derive.ts` is imported by ~a dozen `"use client"` components (console
chrome, dashboard, orders, settings, the mobile PWA client). It imported
`inferExternalCashFlows` from `@/lib/benchmark`, and:

```
derive.ts -> benchmark.ts -> history.ts -> db.ts (barrel: migrations, resolveApiKeyWithSource, crypto)
```

so the SQLite/migration/API-key-crypto graph was being pulled into a browser chunk — the
source of the repeated `ENCRYPTION_KEY` warning in the browser console.

- New `src/lib/cash-flows.ts`: the flow math, extracted verbatim, with **no runtime
  imports** (type-only imports are erased). `benchmark.ts` now imports from it.
- `derive.ts` imports from `@/lib/cash-flows`; `benchmark.ts` keeps `computeSpyBenchmark`
  and its `history.ts` dependency, which only server code uses.
- Regression guard: `eslint.config.mjs` gains a `@typescript-eslint/no-restricted-imports`
  rule scoped to `app/console/**` and `app/mobile/**` forbidding value-imports of the
  server modules, with `allowTypeImports: true` (a type-only `@/lib/db` reference costs
  the bundle nothing and stays legal). Lint is a required CI step, so a regression fails
  the gate with an actionable message.

`server-only` was considered and rejected: it is not a dependency of this repo, and adding
one to enforce a boundary that a zero-dependency lint rule already enforces at the same
point in the pipeline is not worth the install surface — especially given the npm blocker
in §4.

### CI — deleted the unreachable `verify-self` lane (finding 29, half REAL)

The "runner policy contradiction" half was **already fixed** — `AGENTS.md:156` has said
"Fleet CI = GitHub-hosted only" since 2026-07-29. (The stale text the reviewer quoted is
what the *main integration worktree* still shows, because it is 3 commits behind
`origin/main`.)

The code half was real: `classify`'s routing step hardcoded `route=hosted`, so
`verify-self`'s `if:` could never be true — ~105 lines of dead workflow. Worse, had it
ever run it would have failed instantly: it looked for Homebrew's
`/opt/homebrew/opt/node@24/bin` on `runs-on: ubuntu-latest`.

Removed the job, the routing step, the `route` output, and the now-unreachable
`HOSTED_RESULT == skipped && SELF_RESULT == success` branch in the required `verify`
gate — that branch was the only way a *skipped* verification lane could report PASS on a
non-docs diff, so deleting it makes the gate strictly more fail-closed. Job ids
(`verify`, `verify-hosted`) are unchanged, so branch protection is unaffected. Validated
by parsing the YAML and asserting the job graph.

### Admin operator-access notice (finding 19, reviewer WRONG; fixed anyway)

The claim was "six admin probes run but `allForbidden` requires exactly five". Six
requests do fire, but only five are operator-gated — `/api/chat-history` uses
`resolveRequestUserId` with no admin check and returns 200 for any signed-in user, so
exactly five keys are written for a non-operator and `=== 5` was correct.

It was still brittle for a reason the reviewer did not identify: any transient *network*
failure on `chat-history` writes a sixth key and silently suppresses the notice. Replaced
the count with membership over an enumerated `ADMIN_PROBE_KEYS` list.

### Coach provider status (finding 18, REFUTED; different fix applied)

The reviewer asked for fail-**closed**. That would mean one flaky `/api/chat/providers`
response locks the user out of Coach entirely — precisely the paternalism AGENTS.md's
product-philosophy section rejects, and worse than the failure it prevents (a missing key
already produces a clear error on send).

The real defect is honesty, not the gate: an empty status map is indistinguishable from
"every provider has a key". Added `statusUnknown`, so a failed check now says key
availability could not be verified instead of implying everything is fine. Selection stays
open.

### Project-state documents (finding 30, CONFIRMED) — and the root cause

Confirmed, with a root cause the review did not name: `.gitattributes` sets
`merge=union` on `STATUS.md`, `PLAN.md`, and `docs/EFFORT-LOG.md`. Union-merge
*interleaves* both sides of a concurrent edit rather than conflicting, which mechanically
produces exactly the reported symptoms.

- `docs/EFFORT-LOG.md`: 13 exact-duplicate blocks (some tripled). Deduped on whole-block
  equality, keeping the first (newest-positioned) occurrence — 4380 → 4270 lines. Same
  applied to the live board `~/apps/TRADING-EFFORT-LOG.md`. No agent's row was removed;
  only byte-identical repeats of a surviving row.
- `STATUS.md`: had one agent's Pushover implementation notes filed under *another
  agent's* "Coolify token split (GROK)" heading, plus a duplicated sign-off line — a
  visible union collision. Restored to the snapshot AGENTS.md actually specifies (state /
  blockers / next action); the changelog moved to `docs/status-archive.md`, where the
  corruption is preserved as-found and annotated as evidence.

Union-merge was **not** removed. It is deliberate — it stopped auto-merge-armed PRs
rotting into CONFLICTING on every board edit. The tradeoff is now documented in STATUS.md
so the next agent does not rediscover it. Whether STATUS.md (a snapshot, which wants
last-writer-wins) should keep union semantics is an owner decision, not an agent's.

## 3. Decisions & Trade-offs

- **Refutations were kept as findings.** #2 (run-once durability): `insertStrategyRun()`
  runs synchronously before `runStrategyOnce`'s first `await`, i.e. before the 8s race
  even starts timing, so the run *is* persisted before the 202 — the surviving residue is
  a cosmetically empty `runId` with no consumer. #10/#12/#13 (native) were refuted on
  their mechanisms. Fixing a refuted finding would have been churn.
- **No provider credential was created, rotated, or inspected** (standing rule). FMP 403
  and the Massive history cap are owner decisions; they are recorded as blockers.
- **iOS/native was left alone.** A peer agent had claimed `ios/**`; that claim turned out
  to be 10 days stale and its worktree no longer exists, but the native findings were
  refuted or owner-blocked anyway.

## 4. Verification State

```
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit                 # exit 0, no errors
npx vitest run test/benchmark.test.ts test/csp-report.test.ts test/security-headers.test.ts
                                 # 3 files, 28 tests passed
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
                                 # jobs: classify, verify-hosted, verify — graph asserted
```

**Environment blocker found while setting the lane up (not caused by this change):**
`npm install` and `npm ci` both fail on npm 11.16 preparing the `congress-trading-shared`
git dependency — `EALLOWSCRIPTS: --allow-scripts is not allowed in project-scoped
installs`. npm passes that flag to its own nested preparation install; the `allowScripts`
field already present in `package.json` does not satisfy it. The failure leaves
`node_modules` **empty**, which reads as janitor reaping. Every agent lane on this machine
is affected. Working command today:

```
npx -y npm@10 ci --no-audit --no-fund
```

CI is unaffected (`ubuntu-latest` + `actions/setup-node`). A durable fix — pin
`packageManager`, or vendor the shared package — is filed as a next step.

## 5. Next Steps & Blockers

- **Production is 3 commits behind `main`** (live `d456ca58` vs `88e614d7`) and
  auto-deploy has not closed the gap. Merging is not currently evidence of shipping.
- Pin or work around the npm 11.16 git-dep failure so agents can run the gates locally.
- Owner decisions: FMP subscription (403), Massive plan tier.
- Open question for the owner: keep `merge=union` on `STATUS.md` now that it is a
  snapshot rather than an append-only log?

## 6. Zero-Code Findings

- Live health confirms the review's deploy-drift claim exactly: `release.sha` =
  `d456ca58`, three commits behind, including two code changes.
- Finding 27 confirmed by direct observation: the unauthenticated endpoint publishes the
  OpenRouter credit balance in USD, raw storage byte counts, and the scheduler lease owner
  id.
- Findings 5/8/9 are ops or owner-gated, not repo changes.
