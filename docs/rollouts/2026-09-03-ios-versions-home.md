# 2026-09-03 — AppUpdatePrompt reads ai-fleet-coordinator

Owner is deleting `jaywedgeworth22/ios-app-versions`.  Personal-Site does not
link it.  The public TestFlight/App Store manifest now lives at
`site/ios-versions.json` in `jaywedgeworth22/ai-fleet-coordinator`.

`AppUpdatePrompt.swift` (pin + iOS copy) and `publish-ios-versions.sh` now
use:

https://raw.githubusercontent.com/jaywedgeworth22/ai-fleet-coordinator/main/site/ios-versions.json

Local `scripts/ios-fleet/ios-app-versions.json` stays the vendored cache /
stale fixture.  Already-shipped builds keep the old URL until the next
TestFlight.  Failures are silent.

## Verification

```bash
bash scripts/ios-fleet-pin.sh --check
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/ios-fleet-app-update-prompt.test.ts
node --test scripts/ios-fleet/publish-ios-versions.test.mjs
```
