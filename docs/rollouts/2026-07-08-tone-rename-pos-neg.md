# 2026-07-08 — Tone vocabulary rename: up/down → pos/neg in the `ui` system (MONET)

## Summary

Implements UI-audit finding 1.2 (owner-endorsed 2026-07-08: "the UI audit is where they
said things needed to be renamed"): standardize both design systems on ONE tone vocabulary.
The console system already used `pos/neg`; the `ui` (glass-token) system used `up/down`,
which collides with price-direction language in a trading app. This renames the `ui` side
to match — the audit's "keystone unification" seam and the first step of its Phase-1
sequencing, shipped as its own PR per the audit's bisectability advice.

Pure rename, zero recolor: computed values verified identical before/after in BOTH themes
(light `text-pos` #15803d / `text-neg` #e11d48; dark #34d399 / #fb5e74 / neg-fg #2b0a10).

## Changes

- `app/globals.css` — tokens `--up`/`--down`/`--down-fg` → `--pos`/`--neg`/`--neg-fg`
  (light + dark blocks) and `@theme` mappings `--color-up`/`--color-down`/`--color-down-fg`
  → `--color-pos`/`--color-neg`/`--color-neg-fg` (renames the generated Tailwind utilities
  `text-up`→`text-pos` etc.).
- `app/ui/primitives.tsx` — `Tone` union `"up"|"down"` → `"pos"|"neg"` (Chip/Dot/StatTile/
  Segmented maps + `Dot` default), with a comment citing the audit finding.
- `app/ui/model-picker.tsx`, `app/ui/price-chart.tsx` (cssVar reads `--up`/`--down` →
  `--pos`/`--neg`), `app/error.tsx`, and the four admin clients (`connections-health`,
  `llm-usage`, `rag-coverage`, `transcript`) — class + tone-literal migration, including
  `statusTone()`'s return union in connections-health.
- `docs/design/visual-system.md` — token table + tone-union documentation updated with the
  rationale.

Console files untouched (already `pos/neg`). No CSS color VALUES changed anywhere.

## Why

UI audit `docs/reviews/2026-07-05-ui-audit-and-design-system-unification.md`, finding 1.2:
"Standardize on one tone vocabulary as the first unification seam. pos/neg reads better
than up/down for a trading app (up/down collides with price-direction language) — adopt it
in both systems even before any larger merge." Owner confirmed this is the rename they
wanted. Closes the 55-findings board row "[P2][DS][S] pos/neg vs up/down tone vocab".

Note on the owner's earlier phrasing ("rename the green and red teams"): exhaustive search
confirmed no panel proposes renaming the Green/Red TEAM names — the audit's rename is this
green/red TONE vocabulary (plus the nav 'Decisions' noun collision, which needs an owner
copy choice and stays a separate Planned row).

## Files

- `app/globals.css`, `app/ui/primitives.tsx`, `app/ui/model-picker.tsx`,
  `app/ui/price-chart.tsx`, `app/error.tsx`
- `app/admin/connections/connections-health-client.tsx`,
  `app/admin/llm-usage/llm-usage-client.tsx`,
  `app/admin/rag-coverage/rag-coverage-client.tsx`,
  `app/admin/transcript/transcript-client.tsx`
- `docs/design/visual-system.md`, `STATUS.md`, `docs/EFFORT-LOG.md`

## Verification

- `npx tsc --noEmit` clean — the union rename makes any unmigrated `tone="up"/"down"` a
  type error, so tsc is the completeness proof (per the audit's own Phase-1 note).
- `npm run lint` 0 errors; `npm test` 2972/2972; `npm run build` via land.sh gate.
- Driven live (dev server): computed-style probes confirm the renamed utilities resolve to
  the byte-identical color values in light AND dark themes (values listed above).
- Repo-wide grep: zero residual `text-up|text-down|bg-up|bg-down|--up|--down|tone="up"|
  tone="down"` outside `app/console` (console never used them).

## Follow-ups

- Nav noun collision ('Decisions' labels the approvals queue while /console/decisions/[id]
  is the trace route) — the audit says resolve the collision but keep branded names; WHICH
  surface keeps 'Decisions' is an owner copy choice. Options presented to owner.
- The audit's fuller Phase-1 items (shared token-core file; console TONE_VAR consolidation)
  remain separate Planned rows.
