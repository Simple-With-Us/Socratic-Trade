# 2026-08-17 — Web / mobile-web / iOS parity audit (report-only)

## 1. Context & Objective

Owner asked for a desktop-web, mobile-web, and native-iOS audit covering feature parity, control/state clarity, accessibility, responsive behavior, deep links, notifications, offline/error, performance, and tests.  The owner does not use the PWA.  Mobile website means `/console` at phone width, not `/mobile`.

## 2. Changes Made

Docs only.  No product, iOS, or test-code behavior change.

- High-level: one audit with a three-client matrix, evidence, severity, fix slices, and a safe PWA-deletion plan.
- Files:
  - `docs/audits/2026-08-17-web-ios-parity.md`
  - `docs/rollouts/2026-08-17-web-ios-parity-audit.md`
  - `STATUS.md`
  - `PLAN.md`
  - `docs/EFFORT-LOG.md`

## 3. Decisions & Trade-offs

- Report-only PR.  Implementation is sliced A–F in the audit §16 so the next agent does not mix deep-link work with PWA deletion.
- Authenticated screenshots were not captured here (no owner session, no iOS Simulator on this VM).  §12 is the shot/test recipe for the first fix PR.
- Corrected a stale explorer claim: AASA **does** claim `/console/results`.  The real alias hole is `/console/coach`.
- Did not delete `app/mobile/components` in this PR even though it is dead — removal needs the §11 sequence so iOS `/api/mobile` is untouched.

## 4. Verification State

```
# Docs-only.  No tsc/test/build required for product behavior.
# Spot-checked:
#   app/console/approvals/page.tsx — no useSearchParams
#   app/console/components/approval-card.tsx:455 — no article id
#   src/lib/push-deep-links.ts:91-102 — emits ?proposal= and ?symbol=
#   ios/SocraticTrade/DeepLink.swift:75-77 — drops query on orders/watchlist
#   app/console/lessons/page.tsx:5 — --con-page-w undefined
#   app/mobile/page.tsx — redirect /console
```

Build status: not run (no runtime change).

## 5. Next Steps & Blockers

- Owner (or next agent) picks slice A from the audit: web `?proposal=` / `?symbol=` consumers + tests.
- Do not invest in `app/mobile/**` except the existing redirect.
- Screenshot pass needs a signed-in `/console` and a booted Simulator.

## 6. Zero-Code Findings

See `docs/audits/2026-08-17-web-ios-parity.md`.  Headline: notification URLs are more precise than any web client, and more precise than iOS for symbols; iOS Activity is not the web Alert Center.
