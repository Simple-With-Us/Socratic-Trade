# 2026-06-29 — Modal z-index fix

## Summary
The Settings / Help / Accounts modal (`Modal` component in `app/ui/overlays.tsx`) was rendered
at `z-[1000]`, while the dashboard header sits at `z-[1100]`. This caused the modal backdrop
and content to appear *behind* the header, making it impossible to interact with any modal
controls that overlapped the header area. Raised the modal container from `z-[1000]` to
`z-[1300]` so it clears both the header (`z-[1100]`) and any other fixed chrome.

## Why
Single-line root-cause: the header z-index was raised to 1100 in a previous PR but the modal
was never updated to match, leaving a 100-unit gap that the header exploited.

## Files touched
- `app/ui/overlays.tsx` — `z-[1000]` → `z-[1300]` on the `Modal` container div

## Verification
- `npx tsc --noEmit` — clean (exit 0)
- `npm run lint -- --quiet` — ESLint was unresponsive in the sandbox environment (hung on
  `eslint .`); the change is a single Tailwind class string with no logic, so no lint rule
  can fire. CI `verify` will run lint on the PR and catch any issues.
- `npm test` / `npm run build` — skipped locally per task instructions; CI `verify` covers both.

## Follow-ups
None. The fix is complete and self-contained.
