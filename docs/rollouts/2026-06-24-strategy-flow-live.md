# 2026-06-24 — Strategy Flow: static diagram → live pipeline status

## Summary

The "Strategy Flow" popup (Strategy tab, full-screen modal) was a purely
decorative React Flow diagram: hardcoded nodes (Pinecone, illustrative agents)
and edges that always rendered the same regardless of system state. The owner
found it "fancy but not functional" and couldn't tell what it conveyed.

It is now **data-driven**: every node's status (Active / Ready / Off / Check)
and detail line is derived from the real dashboard snapshot the cockpit already
polls. Nothing is hardcoded "always green".

## What changed

- `app/ui/strategy-flow.tsx` — full rewrite. `StrategyFlow` now takes a
  `snapshot` prop and `buildSpecs(snapshot)` derives the graph from live fields:
  - **Data sources (col 0):** Market Data (scan candidate count + source),
    Macro/FRED (`macroBoard` + regime label), Smart Money
    (`webSources.congress/insider/finra` enabled + rowcount + freshness),
    SEC Filings + RAG (`webSources.sec8k`), Technicals (`webSources.technical`,
    TradingView vs computed). A source shows **Off** when disabled, **Ready**
    when enabled but no rows yet, **Active** when it has data.
  - **Pipeline (cols 1–5):** Scan & Score (ranked-candidate count + age),
    Strategy Agent/Bull (per-user `llmModel` + proposal count from last run),
    Bear/Red-Team, Evaluator (thesis-scorecard count), Policy Gates (count of
    active limits + `systemState`, **Check** when halted), Risk Manager
    (stop/take %), Execution (Test/Paper/Brokerage · Propose/Autonomous,
    **Active** only when `systemState === "active"`).
  - Edges animate only when their upstream node is **Active**; otherwise dim.
  - Added a legend row explaining the colors. Graph re-seeds on every snapshot
    poll via a `useEffect` syncing `setNodes`/`setEdges` (the previous
    `useNodesState` seed-once would have left it stale after the first render).
- `app/dashboard-client.tsx` — pass `snapshot={snapshot}` into `<StrategyFlow>`;
  modal subtitle "Pipeline & node visualizer" → "Live pipeline status".

## Why

Owner request: "Make it live/data-driven." A static diagram next to real,
honest data is misleading (same anti-pattern as the removed mock enrichment
tier). Lowest-risk path was client-side rebuild from the existing snapshot — no
new backend, no new endpoint.

## Files

- `app/ui/strategy-flow.tsx`
- `app/dashboard-client.tsx`
- `STATUS.md`, this rollout note.

## Verification

- `npx tsc --noEmit` — clean (after `npm install` pulled #110's `next-auth` /
  `jose` into this fresh checkout off `origin/main`).
- `npm run build` — succeeds.
- `npm test` — 935/936 pass. The single failure is the **pre-existing
  date-sensitive** `test/cache-provenance.test.ts` (expects `"unavailable"`,
  gets today's date `2026-06-24`) — unrelated to this change.

## Follow-ups

- The node set is still a fixed topology (it reflects the real pipeline stages),
  but per-run "which agents actually ran / gate pass-fail counts" could be
  surfaced further if the strategy-run audit payload is extended.
- Codex review findings from this session are tracked separately (OOS-gate HIGH
  bug, etc.) — see chat handoff; not fixed here.
