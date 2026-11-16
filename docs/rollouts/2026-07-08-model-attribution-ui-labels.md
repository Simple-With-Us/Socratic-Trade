# 2026-07-08 — Model attribution on every decision surface (MONET)

## Summary

Owner-directed: every decision shown in the app now displays WHICH LLM model made it — or
failed to make it — in small type, with the model vendor's logo where it fits (the existing
console `ModelBadge`/`ProviderLogo`, `public/model-logos/*.svg`).

What already existed (found before building — reuse, don't rebuild): `proposedByModel` and
`redTeamVerdict.model` are persisted failover-aware on every proposal; `socratic_decisions`
has dedicated `model`/`red_team` columns; the approval card already badges the green + red
models; the activity feed already prints "model via Provider (status)" per LLM step; chat
turns already badge their model. The real gaps were:

1. **Failure states were persisted but never rendered.** `redTeamVerdict.failureKind`
   ("not_configured" | "timeout" | "provider_error" | "rate_limited" | "malformed_response")
   existed on the type since the policy-aware-routing work, but both the approval card and the
   decision trace gated their Red Team block on `verdict.available` — a FAILED review was
   visually identical to "no review ever ran".
2. The decision-trace page rendered the deciding model as raw text, not the badge.
3. The console-home "Adversarial review" evidence row was invisible for failed reviews.
4. Mobile showed no model attribution at all (the snapshot already carried the data; the
   client type just narrowed it away).

## Changes

- **`app/console/lib/red-team.ts` (new, pure client module):**
  - `redTeamFailureMeta(failureKind)` → `{label, title}`; the label reuses the server's
    `describeRedTeamFailureKind` (`src/lib/red-team-routing.ts`, type-only imports, safe in
    client bundles) so chip wording matches the "(provider error)"-style rationale suffixes.
  - `redTeamFailureModel(verdict, configuredRedTeamModel)` — honesty rule: persisted verdict
    model first; `not_configured` returns **null** (never blame a model that provably never
    ran); other failures may fall back to the configured red-team model.
- **`app/console/components/approval-card.tsx`:** Red Team block now renders for ANY
  persisted verdict. `available: false` shows the failed-reviewer `ModelBadge` (or "no
  reviewer model configured" for `not_configured`) + amber "No verdict: review failed
  (<kind>)" + the trigger chip when known. When NO verdict exists at all, a one-line faint
  note renders: "No adversarial review ran for this proposal — below every dissent trigger"
  (composite-review "render dissent honestly: the empty state is information").
- **`app/console/decisions/[id]/page.tsx`:** Action card now shows the deciding model as a
  `ModelBadge` (was raw text), with an honest "deciding model not recorded" fallback for
  legacy cases. Dissent section badges the reviewer model on the verdict card and adds a
  failed-review card (badge + "review failed (<kind>)") when `available: false`.
- **`app/console/page.tsx`:** the evidence-rows builder adds an "Adversarial review FAILED"
  row (model · failure label, hover explanation, warn tone) instead of dropping failed
  reviews.
- **`app/mobile/mobile-pwa-client.tsx`:** proposal cards get a compact text-only attribution
  line — "Proposed by <model> · Red team: survived/rejected — <model>" or "Red team FAILED
  (<kind>) — <model>" (text-only on mobile to avoid crowding; console keeps the logos).
  Local `PendingProposal.proposal` type extended with `proposedByModel`/`redTeamVerdict`
  (the `/api/mobile/snapshot` payload already carried them via `snapshot.pendingProposals`).
- **`app/console/lib/models.ts`:** display names for `deepseek-chat`/`deepseek-reasoner`
  (real DeepSeek API ids that persist on historical proposals; previously rendered raw).
- **`test/console-red-team-labels.test.ts` (new):** 6 tests pinning the label wording to the
  server helper and the never-blame-a-model-that-never-ran attribution rules.

Deliberately NOT badged: `congressScoreVerdict` (statistical gate, no model — labeling it
with a model would fabricate attribution); Bull-call failures that produce no proposal (they
already surface in the activity feed as `llm_step` "failed" rows WITH model + provider);
the secondary LLM decisions (tuning / post-mortem / outcome / revalidation) whose served
model lands only in the `llm_usage` ledger today — attributing those on their own artifacts
needs a persisted field per record and is logged as a follow-up.

## Why

Owner request 2026-07-08 ("all decisions on the app should show the model that made them
(or failed to make them), maybe in smaller font and with a little logo"). Also closes the
UI half of two catalogued review findings: composite-review "Render dissent honestly: three
distinguishable states" and builds toward "per-model learning loop" visibility.

## Files

- `app/console/lib/red-team.ts` (new)
- `app/console/components/approval-card.tsx`
- `app/console/decisions/[id]/page.tsx`
- `app/console/page.tsx`
- `app/console/lib/models.ts`
- `app/mobile/mobile-pwa-client.tsx`
- `test/console-red-team-labels.test.ts` (new)

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (335 pre-existing grandfathered warnings).
- `npm test` — 2895/2895 passed (287 files) + the 6 new tests green.
- `npm run build` — clean. (`next-env.d.ts` dev-vs-build churn reverted, not committed.)
- **Driven live** (dev server on a throwaway seeded DB, three proposals: survived / FAILED
  (provider_error) / no-review): `/console/approvals` renders all three states — MSFT
  "Verdict: survived review" + Anthropic badge; NVDA "No verdict: review failed (provider
  error)" + the failed reviewer's badge; KO "No adversarial review ran…" with green badge
  only. `/mobile` renders the three compact attribution lines. Screenshot captured in
  session. The decision-trace failed-state card was not driven (needs a seeded socratic
  case) — same helper + badge combo as the driven approval card, covered by tsc/tests.

## Follow-ups

- Per-artifact served-model attribution for tuning / post-mortem / outcome-postmortem /
  proposal-revalidation records (today: `llm_usage` ledger only). One field each; blocked
  rows exist in the LLM-usage-per-account deferred list (CLAUDE-Cowork keepout on
  `strategy`/`red-team` files at the time; re-check after the single-adversary
  consolidation).
- Closing the per-model learning LOOP (outcome scoring by model, calibration by model,
  routing) remains the big catalogued item (composite-review convergence #2) — this change
  is the display layer only.
