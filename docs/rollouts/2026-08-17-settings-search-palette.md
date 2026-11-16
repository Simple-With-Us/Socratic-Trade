# 2026-08-17 — Wire settings-search catalog into the command palette (#2558)

## Context & Objective

`app/settings-search.ts` already had a complete searchable catalog (`SETTINGS_FIELDS`, `searchSettings`, `SETTINGS_GLOSSARY`, relocation map) and nothing in the UI imported it.  Issue #2558 asked to wire that catalog into the console command palette and to drop the phantom `defaultLandingAccount` field (and its "Live accounts can't be auto-selected, for safety" copy, which contradicts the no-paternalism ruling).

## Changes Made

⌘K / Ctrl+K now searches the existing catalog once the query is non-empty.  Hits render in a **Settings** group and deep-link to the live console path + section hash (`#appearance`, `#delivery`, `#api-keys`, `#autonomy`, …).  The phantom landing-account field is gone from the catalog and from the Display glossary row.

- `app/settings-search.ts` — removed `settings.defaultLandingAccount`; added `anchor`, `pathForSettingsDestination`, `settingsDestinationLabel`, `hrefForSettingsField`, `settingsPaletteHits`; Display glossary no longer mentions a default landing account.
- `app/console/components/command-palette.tsx` — settings hits appended under a Settings heading; placeholder / trigger copy mention settings.
- `app/console/console.css` — `.con-cmdk-group` heading style.
- `test/settings-search-index.test.ts` — phantom-field absence, live href/hash coverage, palette-hit shape.
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this note.

## Decisions & Trade-offs

- **Remove, do not implement, the landing-account field.**  It existed only in the catalog.  Implementing it would reintroduce the paternal "non-Live only" cage the owner already rejected.
- **Settings hits only after the user types.**  An empty palette still lists screens and actions; dumping the whole catalog on open would bury those.
- **Catalog stays the SSOT.**  Hrefs are derived from destination + optional `anchor` on the same field row (no parallel URL list).
- **Same-page hash scroll.**  `router.push` to a hash on the page you are already on may not remount, so the palette also `scrollIntoView`s the target id.
- Did not fold `SETTINGS_GLOSSARY` into the Help card (separate glossary already lives at Settings → #glossary).  Old names still resolve via field synonyms in the palette.

## Verification State

Commands run after the first push (see follow-up if any):

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/settings-search-index.test.ts test/settings-tree-scope.test.ts test/guardrails-essentials.test.ts test/openSettings-relocation.test.ts
npm test
npm run build
```

Status recorded in the PR after the gate finishes.

## Next Steps & Blockers

- Merge #2558 when `verify` is green (auto-deploy on `main`).
- Optional follow-up: add more live Settings sections (confirmation, data-sources, boot) as catalog rows so those anchors are first-class search hits, not only reachable via destination synonyms.

## Zero-Code Findings

None — this was a wiring + catalog-honesty change.
