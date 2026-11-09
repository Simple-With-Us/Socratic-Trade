# 2026-07-09 Extended Hours Tooltips

- Summary: Added tooltips to the "Run during extended hours" and "Allow extended-hours orders" fields in the UI.
- Why: To provide a brief explanation of what these toggles control without cluttering the UI.
- Files: `app/console/guardrails/field-defs.ts`
- Verification: Ran `npm run lint && npx tsc --noEmit && npm test && npm run build`. All 3168 tests pass and the build is clean.
- Follow-ups: None.
