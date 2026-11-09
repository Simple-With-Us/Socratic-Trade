# 2026-06-21 - strategic-framework-plain-english

## Summary

- Added `docs/strategic-framework.md`: a plain-English (college-level, no prior
  investing experience assumed) outline of the entire strategic framework of the
  app, with an explicit, honest weaknesses/limits/risks section.
- Doc is structured as a **living document**: it carries its own changelog and
  instructions to update it (and to *move* fixed weaknesses to a "what we fixed"
  state rather than silently deleting them) as the strategy is refined.

## Why

- Owner requested a non-expert-friendly explanation of the whole strategy, with
  honesty where there are weaknesses, shortcomings, or caveats — to be maintained
  over time as the strategy improves.

## Files

- `docs/strategic-framework.md` (new)
- `docs/Strategic-Framework-Overview.pdf` (new — polished standalone PDF for sharing)
- `docs/strategic-framework-overview.html` (new — source HTML the PDF is rendered from)
- `docs/rollouts/2026-06-21-strategic-framework-plain-english.md` (new)
- `STATUS.md` (active-focus entry added)

## Shareable PDF/HTML variant

- `docs/strategic-framework-overview.html` is a self-contained, print-styled
  variant of the framework with the audience line and all internal meta
  (the "living document" note, changelog, and source-doc list) stripped, so it
  reads as a document you'd hand directly to the intended reader. Title is
  neutral ("Strategic Framework Overview") and does not name the audience.
- `docs/Strategic-Framework-Overview.pdf` is rendered from that HTML.
- **Regenerate the PDF** (LibreOffice's `--convert-to` is broken in this env;
  use the bundled Playwright Chromium instead):
  ```bash
  /opt/pw-browsers/chromium-1194/chrome-linux/chrome --headless --no-sandbox \
    --no-pdf-header-footer \
    --print-to-pdf=docs/Strategic-Framework-Overview.pdf \
    file://$PWD/docs/strategic-framework-overview.html
  ```
  Keep the HTML and PDF in sync when the framework changes.

## Sources synthesized

- `PLAN.md`, `PROJECT.md`, `README.md`
- `docs/phase-7-strategy.md` (six evaluation lenses, factor weighting matrix,
  learning loop / auto-tuning, weight-shift guardrails)
- `docs/phase-4-market-data-scoring.md` (factor scoring, data provider floor)
- `docs/phase-1-autonomy-loop.md` (scheduler, run lock, market-hours, no holiday
  calendar)
- `src/lib/policy.ts` (deterministic gates, margin minimum, PDT rule retired)
- `README.md` Safety Defaults (per-order/daily/concentration/frequency caps)

## Honest caveats captured in the doc (state as of this date)

- Factor weights are unproven guesses (advisory tuning only).
- No rigorous historical backtester; validated mostly via forward Test/Paper runs.
- Free-tier data is delayed/incomplete; some smart-money feeds often return nothing.
- Sentiment scoring still largely keyword-based.
- Learning loop is "self-advising," not fully closed into sizing; 20-trade cold start.
- Short/cover accounting not fully proven for real-money use.
- Single-process local scheduler; no market-holiday calendar; local SQLite.

## Verification

- Docs-only change. No code touched, so the tsc/test/build trio was not required
  for correctness, but nothing in `src/` was modified.

## Follow-ups

- Keep `docs/strategic-framework.md` updated as the strategy changes; when a
  listed weakness is fixed, move it out of the Weaknesses section into a
  "what we fixed" note and add a changelog entry.
- Candidate future edits: once a backtester exists, or weight-shifts feed sizing,
  or sentiment moves to an ML model, update Sections 5/9 accordingly.
