# 2026-07-10 — Canonical market-data provider pricing doc

**Summary:** new `docs/market-data-provider-pricing.md` — verified pricing/tier facts for
tiingo, Massive, FMP, Twelve Data, Finnhub, Alpha Vantage, Yahoo; the traps already hit
(tiingo news paid-only; tiingo $300/yr annual missing from the marketing matrix — owner
correction 2026-07-10; AV 25/day enforced per-IP; FMP annual-billed display; Massive scope;
Finnhub $3.5k cliff); current paid/free/considering state; Infisical knob cheat-sheet.

**Why:** two pricing misinterpretations in one day (an agent reported "no tiingo annual";
the AV key pool was built assuming per-key caps). Owner: "put all this pricing info into a
document so we stop misinterpreting things."

**Files:** docs/market-data-provider-pricing.md (new), STATUS.md, docs/EFFORT-LOG.md, this note.

**Verification:** docs-only; land.sh gate (tsc/test/build) before PR.

**Follow-ups:** keep the doc current on every plan change; API-Usage-Monitor
subscription→knob linkage (designed, reserved, paused pending owner unblock) will make the
monitor the live source of truth for what is actually subscribed.
