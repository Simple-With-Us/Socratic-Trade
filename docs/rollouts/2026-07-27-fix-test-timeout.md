# 2026-07-27 — Fix redteam-observability-g10 timeout

Fixed a flaky test timeout in `test/redteam-observability-g10.test.ts` by adding a mock for `sec.gov/files/company_tickers.json`. This prevents a 404 from triggering a slow backoff retry loop in the new SEC XBRL cascade (default enabled in PR #2230), which pushed the test past its 30s timeout under heavy CPU load during the full parallel test suite.
