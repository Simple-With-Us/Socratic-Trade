# 2026-07-06 — Plain-English Anthropic usage-limit error

## Summary

Fixed `humanizeLlmError` (`src/lib/llm-errors.ts`) to recognize Anthropic's org/workspace
"specified API usage limit" error and render it in plain English instead of dumping the
raw provider JSON blob to the user.

## Why

Owner shared a screenshot of a Roth IRA thesis card whose "⚠ RED TEAM FAILED (provider
error)" note read:

```
Red Team debate unavailable — Anthropic (Claude) error: {"type":"error","error":
{"type":"invalid_request_error","message":"You have reached your specified API usage
limits. You will regain access on 2026-08-01 at 00:00 UTC."},"request_id":
"req_011Ccm8KXQnpRLjFAULndY1w"}
```

`humanizeLlmError` already maps common shapes (401/403/404/429/5xx/timeout/context-length)
to plain English, but Anthropic's workspace-level usage-limit error comes back as a 400
`invalid_request_error`, not a 429, so none of the existing branches matched and it fell
through to the generic `${provider} error: ${rawText}` fallback — which surfaces the raw
JSON verbatim, including the `request_id`.

## Fix

Added a branch in `humanizeLlmError` that matches `"usage limit"`/`"usage limits"` in the
error text, extracts a "regain access on <date>" fragment via regex if present, and returns
a plain-English sentence naming the provider and (if available) the reset time — no raw
JSON.

Since `humanizeLlmError` is the single chokepoint most call sites already route error text
through (`red-team.ts`, `strategy.ts`, `outcome-engine.ts`, `post-mortem.ts`,
`proposal-revalidation.ts`, `strategy-tuning.ts`, the Assistant console), this fix applies
wherever those reason/rationale strings are later displayed (thesis cards, decision notes,
journal entries, chat errors) — not just the Red Team debate path shown in the screenshot.

## Files

- `src/lib/llm-errors.ts` — new `usage limit` branch in `humanizeLlmError`.
- `test/llm-errors.test.ts` — new regression test pinning the exact screenshot payload to a
  plain-English, JSON-free output.
- `docs/EFFORT-LOG.md` — Completed entry.

## Verification

```bash
npx tsc --noEmit          # clean
npm run lint              # 0 errors (pre-existing grandfathered warnings only)
npm test                  # 2674/2674 passed (269 files)
npm run build             # fails at /_not-found page-data collection with "Invalid URL";
                           # reproduced identically on a clean `git stash` of main before
                           # this change, so it's a pre-existing environment issue (likely
                           # a missing env var in this cloud sandbox), not a regression
                           # introduced here.
```

## Follow-ups

- An audit agent was dispatched to check for other raw-error-leak sites across the app
  (e.g. `debateViaAnthropic`'s fixed generic reason string, other `response.text()` /
  `error.message` call sites) that don't route through `humanizeLlmError`. If it turns up
  additional leaks, they should land as a follow-up fix referencing this note.
