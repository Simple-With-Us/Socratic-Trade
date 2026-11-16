# Rollout — iOS tab rename: Coach → Insights

**Date:** 2026-08-04  
**Branch:** `grok/ios-rename-coach-to-insights`  
**Author:** GROK

## Context & Objective

The native iOS fifth tab was labeled **Coach** and used a chat-bubble icon, which
implies the web console Coach chat (`/console/assistant`). That tab has never
been a conversation surface: it only shows a snapshot-derived portfolio brief,
rule-based attention items (readiness, proposals, caps, benchmark, alerts), a
Run once control, and an authority note. Owner feedback: rename so it is not
confused with the (separate, under-worked) coaching feature.

## Changes Made

- Tab + navigation title: **Coach** → **Insights**
- Icon: chat bubbles → `lightbulb.fill`
- Types/file: `CoachView` → `InsightsView` (`ios/SocraticTrade/InsightsView.swift`)
- `AppTab.coach` → `AppTab.insights`
- README five-area list updated; comment that this is not web Coach chat
- Regenerated `ios/Socratic Trade.xcodeproj` via XcodeGen

No behavior change; no mobile API change; web Coach/Assistant untouched.

## Verification

```bash
cd ios && xcodegen generate
xcodebuild \
  -project "Socratic Trade.xcodeproj" \
  -scheme SocraticTrade \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
# → BUILD SUCCEEDED
```

## Next Steps

- Web Coach chat product work remains separate (does not belong on this tab until
  a real mobile coach contract exists).
- Optional later: deeper Home/Insights dedupe of readiness messaging.
