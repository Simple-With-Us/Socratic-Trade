# 2026-08-19 — Copy: guardrail claims match advisory engine (`copy-claims-and-rulings`)

## Context & Objective

Expert review cluster `copy-claims-and-rulings` (Part II) found shipped copy asserting hard vetoes and paper/live ceremony the engine and owner rulings reject.  This pass rewrites those strings to match advisory tag-not-drop behavior and centralizes guardrail-semantics sentences in one module.

## Changes Made

- Added `src/lib/guardrail-copy.ts` — canonical guardrail, regime-gate, account-environment, and public-authority sentences.
- Console: macro regime text, Guardrails header, breaker note, Connections labels, glossary, reality banner word (`paper` lowercase), Coach picker (removed Mock group).
- Public: `/how-it-works` authority bullets, `/framework` sizing/verdict invariants, Terms §8 shared market-data pool + `LEGAL_NOTICE_VERSION` bump to 2.
- iOS: `DeskCopy` mirrors key strings; proposal cards drop live pill; paper badge lowercase; removed iOS-only brokerage-account activation confirm.
- `app/console/guardrails/field-defs.ts` imports shared `ADVISORY_NOTE`.

**Files touched**

- `src/lib/guardrail-copy.ts` (new)
- `src/lib/legal-notice.ts`
- `src/lib/market-regime.ts` (comment only)
- `app/console/macro/indicators.ts`
- `app/console/guardrails/page.tsx`
- `app/console/guardrails/field-defs.ts`
- `app/console/components/chrome.tsx`
- `app/console/settings/brokers.tsx`
- `app/console/settings/help.tsx`
- `app/console/lib/derive.ts`
- `app/console/assistant/chat.tsx`
- `app/console/assistant/models.tsx`
- `app/ui/llm-model-catalog.ts`
- `app/how-it-works/page.tsx`
- `app/framework/content.ts`
- `app/terms-and-conditions/page.tsx`
- `ios/SocraticTrade/DeskModels.swift`
- `ios/SocraticTrade/ProposalsView.swift`
- `ios/SocraticTrade/HomeView.swift`
- `test/guardrail-copy.test.ts` (new)

## Decisions & Trade-offs

- Engine behavior unchanged (tag-not-drop stays).  AUTOPILOT typed-confirm path untouched.
- Mock LLM remains test infrastructure; removed from product-facing Coach pickers only.
- iOS strings mirror TS constants via `DeskCopy` comments — no codegen yet.
- Terms effective date bumped; users will see clickwrap re-prompt once (`LEGAL_NOTICE_VERSION=2`).

## Verification State

```bash
npm run lint          # green (grandfathered warnings only)
npx tsc --noEmit      # green
npm test              # (running at handoff)
npm test test/guardrail-copy.test.ts  # 4 passed
```

## Next Steps & Blockers

- Merge PR; auto-deploy on `main`.
- Optional follow-up: codegen or parity test that reads `DeskCopy` literals against `guardrail-copy.ts`.

## Zero-Code Findings

None.
