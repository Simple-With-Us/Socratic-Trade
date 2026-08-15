# Socratic.Trade iOS

Native, phone-first desk for Socratic.Trade. Pin Home, Proposals, Assets,
Activity, Insights, Coach, Scan, Guardrails, or Results — More keeps every
screen reachable. Insights stays a snapshot brief; Coach is the live
`/api/chat` conversation.

The backend remains authoritative. The app reads `/api/mobile/snapshot`, submits
audited work through `/api/mobile/commands`, and listens to
`/api/mobile/events`. Broker credentials, provider keys, policy enforcement,
proposal revalidation, inference, and order placement stay on the server.

## Generate and build

The XcodeGen spec at `ios/project.yml` is the single project definition. The
checked-in `.xcodeproj` is regenerated from that spec so Xcode users can open
and build it directly; never hand-edit it. When the spec changes, regenerate
the project and include the generated project update in the same change.

```bash
cd ios
xcodegen generate
xcodebuild \
  -project SocraticTrade.xcodeproj \
  -scheme SocraticTrade \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Run unit tests against an installed simulator:

```bash
xcodebuild \
  -project SocraticTrade.xcodeproj \
  -scheme SocraticTrade \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  CODE_SIGNING_ALLOWED=NO test
```

The canonical application bundle identifier is `trade.socratic.app`. The
project includes the Sign in with Apple entitlement and the `socratictrade` URL
scheme. The app signs in directly with Apple's identity-token endpoint. Google
and GitHub use `ASWebAuthenticationSession`, but the custom callback carries a
short-lived opaque code bound to a device-generated verifier; the session JWT
never appears in a callback URL and is exchanged into an HTTP-only cookie.

## Data and failure states

Snapshot-backed screens explicitly distinguish first load, retryable errors,
empty sections, refreshing data, and stale data. A cached in-memory snapshot
stays visible through transient network and server errors. Only HTTP 401/403
clears the authenticated session.

SSE parsing dispatches one refresh per complete payload frame and ignores
comments/heartbeats. Store-level coalescing prevents overlapping reload storms.
Each command has its own busy state, so an unrelated command never removes the
Stop action.

## Account deletion

Account & Settings is available from the Home toolbar. Deletion uses the
backend's request/confirm flow, requires both identity and exact phrase, clears
the local cookie session after success, and opens the server-provided logout
URL. Provider-side OAuth revocation remains a separate user action.

## TestFlight ship (no Xcode UI)

Agents (and humans) ship device builds to TestFlight from the CLI:

```bash
# From repo root (agent worktree)
bash scripts/ios-ship-testflight.sh

# IPA only
bash scripts/ios-ship-testflight.sh --export-only
```

Fleet driver (all three apps): `/Users/jay/apps/ios-fleet/README.md`.

Requires team `CC8UTF7ATG` signing on the Mac, an App Store Connect app for
`trade.socratic.app`, and either an Xcode-signed-in session or
`~/.secrets/appstore-connect.env` (App Store Connect API key).
