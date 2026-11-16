# 2026-08-05 — Data sources overhaul (team)

## Context & Objective

Owner: make ST data sources healthy and strategic; FMP only for CT latency;
remove Quiver from ST; provenance on every field; tier-aware keys; fix empty
transcripts; source×datapoint catalog for intelligent routing.

## Changes Made (multi-agent)

| Slice | Commit / PR | Summary |
|-------|-------------|---------|
| Provenance | `bbc54739` | asOf/source/fetchedAt on cascade, history, macro, calendar, symbol_field_latest |
| Soft health + Nasdaq UA | `a98d491c` | Expected 429/caps = yellow not red STOPPED; browser UA for Nasdaq |
| Plan tiers | `67a358cb` | Dropdowns next to optional API keys → quota resolution |
| FMP/Quiver OFF | `12c85657` | Grey OFF chips; FMP policy defaults false; Quiver disconnected |
| Capability matrix + ROIC schedule | this commit | `docs/source-capability-matrix.md` + TS registry; ROIC transcripts scheduled |
| CT FMP latency | Congress.Trade PR #1417 | FMP stable+rapidapi OFF grey; dual-path race when enabled |

### Files (this commit)

- `docs/source-capability-matrix.md`, `src/lib/source-capability-matrix.ts`
- `src/lib/web-sources/roic-transcripts.ts`, `src/lib/scheduler.ts`
- Tests for matrix + ROIC periods

## Decisions & Trade-offs

- FMP product use on ST remains hard-banned; health shows OFF not outage.
- Soft health avoids permanent red STOPPED from free-tier daily caps.
- ROIC calendar quarters are approximate; 404 skips are fine.
- Seeking Alpha RapidAPI may still deliver no data if unsubscribed — soft 403 only.

## Verification State

See land gate: lint → tsc → test → build.

## Next Steps & Blockers

- Confirm prod ROIC key + EarningsCalls entitlement (preview vs full).
- After deploy, Connections should show FMP grey OFF; Nasdaq green after UA fix.
- CT: enable FMP latency only when desired via `FMP_LATENCY_PROBE_ENABLED`.
