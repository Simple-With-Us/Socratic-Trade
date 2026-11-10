# ST-4583: Restore the public footer logo

## Context and objective

Jay reported a broken oversized footer logo on the framework page.  Live inspection confirmed `/swu-logo-wide.webp` returned 404 and the shared footer forced a white background.

## Changes

- `app/ui/public/public-footer.tsx`: use the already bundled transparent light/dark wordmarks, follow the resolved theme, and bound the displayed logo to 288x30 with a narrow-screen maximum.
- `test/public-footer-assets.test.ts`: catch missing bundled assets and lost geometry/theme/background constraints.
- `test/e2e/framework-footer.spec.ts`: check decoded image dimensions, transparency, one visible logo, and viewport bounds in each theme.
- `STATUS.md` and `PLAN.md`: record this focused public-site repair.

No welcome-page or welcome-footer test changes belong to this work; those are tracked separately as ST-4576.  No trading, runtime, native, credential, deployment-setting, or workflow changes.

## Verification

- Public routing and asset unit tests run locally; results recorded in the PR.
- Scoped eslint: zero errors, existing img-element performance warnings.
- Component preview: actual React footer and actual generated Tailwind CSS, inspected at 390px and 1280px in both themes; each has one decoded 288x30 logo, no overflow and no white box.
- Full TypeScript did not finish locally: default heap OOM, then workspace killed a 3GB-heap retry.  Required hosted verify remains authoritative; no full local gate claim.
- Full-page framework Playwright coverage is committed for hosted execution, not claimed run locally.

## Deployment and next steps

Current-head Kody review, resolved findings, and required checks must qualify before merge.  Main merge is not proof of a live repair: the existing regular-hours deployment latch remains in place, and no override is requested.  Inspect live mobile and desktop pixels after the automatic deployment.

This web-only diff is outside iOS ship push paths; scheduled iOS shipping also uses the existing native-path gate.  No native ship or manual deployment was triggered.
