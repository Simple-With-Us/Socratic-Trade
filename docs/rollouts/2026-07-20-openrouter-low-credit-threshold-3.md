# 2026-07-20 — OpenRouter UptimeRobot low-credit threshold $10 → $3

## Summary

Lowered the `/api/health` OpenRouter prepaid-credit alert floor from **$10** to **$3**
(`OPENROUTER_LOW_CREDIT_USD` default). Uptime Robot keywords on
`"openrouterCredits":{"ok":false` need **no change** — only when `ok` flips changes.

## Why

Owner asked after seeing Uptime Robot report OpenRouter credits "nearly out." Clarified:

1. That monitor is **not** Usage-Monitor and **not** the ST key's **$10 weekly** spend limit.
2. It is the **account prepaid remaining** balance from OpenRouter `GET /credits`, compared to
   `OPENROUTER_LOW_CREDIT_USD` (was default **$10**).
3. At ~$30 remaining the probe is green under either threshold; the old $10 floor was still too
   noisy for "nearly out" (would page with ~a week of ST headroom left). Owner direction: alert
   when about **$3** left.

## Files

- `src/lib/openrouter-credits.ts` — `DEFAULT_THRESHOLD_USD` 10 → 3 (+ comment)
- `.env.example` — documented default 3
- `test/openrouter-credits.test.ts` — default $3; ~$4.69 still ok; ~$2.00 → ok=false
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## Verification

```
npx vitest run test/openrouter-credits.test.ts   # 5 passed
```

## Follow-ups

- If prod Infisical/Coolify **sets** `OPENROUTER_LOW_CREDIT_USD=10` explicitly, update that env to
  `3` (or delete the override so the new code default applies). An unset env picks up the new default
  on the next deploy that includes this commit.
- Uptime Robot monitor itself: leave keyword as-is.
- Per-key weekly limits (ST $10/wk, CT $20/wk) are still **invisible** to this health signal; if we
  ever want Uptime Robot to page on key-limit exhaustion, that is a separate probe.
