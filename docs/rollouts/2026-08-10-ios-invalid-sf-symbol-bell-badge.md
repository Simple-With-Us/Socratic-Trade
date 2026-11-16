# 2026-08-10 — iOS: invalid SF Symbol `bell.badge.plus`

## Context & Objective

Owner pasted Xcode/console noise while debugging the native app. Most lines are
system/Network framework chatter; one line was a real app bug that blanks the
Assets toolbar “create alert” icon.

## Changes Made

- Replaced nonexistent SF Symbol `bell.badge.plus` with valid `bell.badge` on the
  Assets (`MarketsView`) trailing toolbar button (Create Price Alert).

Touched:

- `ios/SocraticTrade/MarketsView.swift`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-10-ios-invalid-sf-symbol-bell-badge.md`

## Decisions & Trade-offs

- Used `bell.badge` (same family as existing `bell.badge.fill` / `bell.fill` in
  this file) rather than a generic `plus` so the control still reads as “alert”.
- Left network / QUIC / PointerUI / “cannot add handler” messages alone — they
  are known benign Simulator / Network framework logs, not app regressions.

## Verification State

- Static: SF Symbols catalog has no `bell.badge.plus`; app already uses
  `bell` / `bell.fill` / `bell.badge.fill` successfully elsewhere.
- `xcodebuild` (simulator) run as part of land when available.

## Next Steps & Blockers

- Rebuild/run the app in Xcode or TestFlight; the repeating
  `No symbol named 'bell.badge.plus'` lines should stop and the toolbar icon
  should render.
- Ignore remaining `nw_connection_*`, `quic_crypto_queue_append`, and
  `cannot add handler to 0 from 0` noise unless a real functional failure
  accompanies them.

## Zero-Code Findings (console triage)

| Log | Verdict |
|-----|---------|
| `No symbol named 'bell.badge.plus'` | **App bug** — fixed |
| `quic_crypto_queue_append … max 5` | Benign Network/QUIC internal |
| `nw_connection_copy_* on unconnected` | Benign early metadata probe |
| `cannot add handler to 0 from 0` | Common Simulator / Mach port noise |
| `PointerUI.pointeruid.default-service` | Mac/Simulator pointer service noise |
