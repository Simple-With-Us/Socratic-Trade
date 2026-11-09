# Rollout: per-user source settings UI (FMP + SEC + Infisical knobs)

## Context & Objective

Owner: FMP enable toggles must stay exposed; SEC and other Infisical-only knobs
must be selectable per user in Settings instead of global/hidden. Large surface —
foundation + high-value knobs in this pass; more wiring can follow.

## Architecture

1. **`source-settings-catalog.ts`** — declarative list (FMP modules, SEC 8-K/10-K,
   web sources, RAG, transcripts, enrichment).
2. **`source-settings.ts`** — store in `user_settings` key `source_settings` JSON map;
   resolve order: user override → env → catalog default.
3. **`GET/PATCH /api/settings/source-features`** — Settings UI API; FMP four flags also
   write `TradingPolicy` for backward compatibility.
4. **Settings → Data sources** — grouped toggles/numbers with env/user/default chips and reset.
5. **Runtime wiring (phase 1):** web-sources on/off, 8-K full body, filing max/TTL,
   disclosure RAG, ROIC transcript kill/max. More call sites can migrate to
   `resolveSourceBool` / `resolveSourceNumber` the same way.

## FMP note

Toggles **persist again** (hard coerce removed). **Direct FMP HTTP remains blocked** in
product code (`retired-direct-vendors` / fmp-common) until that ban is deliberately lifted —
UI stores intent so we do not need another rewrite when/if FMP is re-allowed.

## Verification

```bash
npx vitest run test/source-settings.test.ts test/defaults-fmp-retired.test.ts
npx tsc --noEmit
```

## Follow-ups (team-friendly)

- Wire remaining env readers (earningscalls daily, multi-query, HyDE, SEC worker, SEC rate).
- Optional: AsyncLocalStorage userId for request-scoped resolve in multi-tenant paths.
- Per-provider cascade order overrides (beyond on/off).
- Plan-tier PR may land separately on same theme (Connections).
