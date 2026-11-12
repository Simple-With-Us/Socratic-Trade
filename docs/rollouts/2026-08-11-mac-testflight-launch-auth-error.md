# 2026-08-11 — Mac TestFlight installs but will not launch (GROK)

## Context & Objective

Owner: Socratic.Trade (and peers) install fine from TestFlight on this Mac, but
the app "does not work" (does not open). Also: always use **stable Xcode.app**,
not Xcode-beta, for TestFlight / App Store Connect ships.

## Root cause (confirmed on this Mac)

**Not an app logic crash.** Launch Services fails before `main` runs:

| Layer | Error |
|-------|--------|
| UI | `_LSOpenURLsWithCompletionHandler` **-10671** |
| RunningBoard | `RBSRequestErrorDomain Code=5` Launch failed |
| launchd | `NSPOSIXErrorDomain Code=80` **Authentication error** / `Launchd job spawn failed` |
| amfid | `Trust evaluate failure` + `SQL error 'authorization denied' (23)` |

Reproduced for **every** TestFlight iOS-on-Mac install here:

- `trade.socratic.app` (Socratic Trade)
- `trade.congress.ios` (Congress.Trade)
- `services.jays.usage.monitor` / `services.jays.usage.local.monitor`

So this is **host / OS / amfid + TestFlight iOS-on-Mac**, not a Socratic-only bug.

Host facts at diagnosis:

- macOS **27.0** (`26A5353q`) — beta train
- Installed ST binary built with **Xcode 26.6** (`DTXcode=2660`, `iphoneos26.5`) — already stable Xcode, not beta
- Signature: TestFlight Beta Distribution / team `CC8UTF7ATG`
- `spctl` rejects wrapper with "resource envelope is obsolete" (common for TF iOS wrappers; secondary to amfid deny)

## What we changed in-repo / fleet

1. **Force stable Xcode for ships**
   - `/Users/jay/apps/ios-fleet/ship-testflight.sh` — if `DEVELOPER_DIR` empty or points at `Xcode-beta`, set `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` and log `xcodebuild -version`
   - `scripts/ios-ship-testflight.sh` (ST wrapper) — same pin before `exec` fleet script
2. **iOS Info.plist** — explicit `LSRequiresIPhoneOS=true` (project.yml + Info.plist)
3. **Login web-auth presentation anchor** — never `preconditionFailure` if scenes/windows are briefly empty (iOS-on-Mac race); fall back safely

These do **not** fix amfid Code=80 on macOS 27 beta; they prevent shipping with Xcode-beta and harden auth presentation once the OS lets the process start.

## Owner / host mitigations (outside code)

1. Prefer **stable macOS** for daily TestFlight-on-Mac use until Apple fixes amfid TF iOS launch on 27.x beta.
2. In **System Settings → Apple ID / Media & Purchases**, confirm the same Apple ID used for TestFlight is signed in.
3. Delete the Mac install → reinstall from TestFlight after a reboot (clears stale LS registrations; also unregister Debug-iphoneos DerivedData copies of the same bundle id if agents left them).
4. iPhone/iPad TestFlight remains the validation path while Mac spawn auth is broken system-wide.
5. Do **not** point `xcode-select` or ship scripts at `Xcode-beta.app` for ASC uploads.

## Verification

```bash
# Reproduce (expect -10671 while OS bug open):
open -a "Socratic Trade"
/usr/bin/log show --last 1m --predicate 'eventMessage CONTAINS "-10671" OR eventMessage CONTAINS "Authentication error"' --style compact | tail

# Ship tool uses stable Xcode:
DEVELOPER_DIR= bash scripts/ios-ship-testflight.sh --dry-run
# log should show DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
```

## Next steps

- Re-check Mac launch after macOS 27 beta updates (amfid TF path).
- Keep shipping TF with stable Xcode only.
- Optional later: native Mac Catalyst / Mac target if Designed-for-iPad stays unreliable on beta hosts.
