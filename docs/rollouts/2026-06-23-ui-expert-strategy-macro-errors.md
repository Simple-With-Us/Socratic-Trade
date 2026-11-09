# 2026-06-23 - UI Expert Strategy, Macro, and Error Pass

## Summary

Applied a UI expert pass across strategy-model placement, run-state clarity,
Macro/Market Scan explanations, proposal aging, title capitalization, and raw
error handling.

## Why

The app had several confusing overlaps: Green/Red Team model controls were
appearing under connection setup instead of the strategy editing surface, Run
once failed while the system was stopped, raw provider JSON leaked into toasts
and Latest Decisions, and beta/agent preview freshness was not codified. Macro
and Market Scan also needed more consistent hover explanations and more useful
default columns.

## Files

- `app/dashboard-client.tsx` - moved editable Green/Red model controls into
  Strategy Studio; left Connections as provider keys plus a read-only model
  summary; removed header Refresh/Flow/Strategy shortcuts; persisted workspace
  and feed tabs; changed Run once to manual proposal checks; added proposal
  timestamps/age chips; translated common API/provider errors; cleaned title
  casing; changed ticker-logo choices to Option 1 / Option 2 / Off; changed
  Market Scan sources and default columns.
- `app/api/strategy/run/route.ts` - accepts a manual run flag.
- `src/lib/strategy.ts` - lets manual runs execute while stopped but forces
  proposal-only behavior; scheduled/autonomous runs still require Start.
- `app/ui/macro-panel.tsx` - expanded Macro tooltips, made Top Gainers/Top
  Losers title-cased lists, and made mover tickers clickable into the symbol
  drawer while percent changes keep directional color.
- `app/ui/assistant-console.tsx` - converts chat API error payloads into plain
  English instead of raw response bodies.
- `app/dashboard-types.ts`, `src/lib/dashboard.ts`,
  `src/lib/dashboard-feed.ts` - carry latest strategy-run timestamps into the
  decision surface for proposal aging.
- `AGENTS.md` - added preview freshness policy for beta vs agent preview sites.
- `STATUS.md`, `PLAN.md`, `docs/phase-8-cockpit-ui.md`,
  `docs/phase-11-multi-user.md` - updated handoff and phase docs.
- `docs/rollouts/2026-06-23-green-red-llm-routing.md`,
  `docs/rollouts/2026-06-23-settings-connections-llm-setup.md` - amended the
  same-day notes to point to the final Strategy Studio placement.

## Verification

- `npx tsc --noEmit` - clean.
- `npm test` - 97 files passed, 888 tests passed.
- `npm run build` - clean.
- Production local smoke: `CF_ACCESS_TRUST_EMAIL_HEADER=1 PRIMARY_USER_EMAIL=... PORT=4216 npm run start -- --hostname 127.0.0.1`, then authenticated `curl` to `/` returned `200` with a complete response (`52115` bytes).
- Browser smoke limitation: the in-app browser could not complete local visual verification in this environment. `127.0.0.1:4216` failed inside the in-app browser with incomplete chunked encoding, and `localhost:4216` was blocked by the browser URL policy. No policy bypass was attempted.

## Follow-ups

- Consider replacing native `title` attributes with an app-level help affordance
  or info drawer for richer hover/click explanations across all controls and
  data points.
- Strategy Flow still needs a product decision: either fully define it as a
  useful pipeline visualizer/editor or remove it from primary surfaces.
