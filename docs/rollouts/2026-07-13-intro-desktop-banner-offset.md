# 2026-07-13 — Intro wordmark assembles at the wrong height (desktop banner offset)

## Summary

Follow-up to the same-day mobile size-jerk fix. On **desktop** (and, less
visibly, mobile) the first-load candlestick intro assembled the "SOCRATIC TRADE"
wordmark **higher** than the real header logo, then it **dropped down when the
page finished loading**. Now the wordmark assembles at the real header position
for any returning session (no drop), and lands accurately-enough on a cold first
visit (then self-corrects).

## Why / root cause (measured empirically)

The intro's flying candles land on the real top-bar logo (`[data-brand-logo]`),
measured from the DOM. But on a **first visit the loading screen renders neither
the chrome nor the logo** — `ShellFrame`'s `loading` branch mounts only the intro
+ a null `LoadingBrand`; the real `ChromeBar`/logo appear only when the snapshot
arrives. So the intro assembles at its hardcoded fallback box until then.

Measured real-vs-fallback geometry (Chromium, no-account = non-live → banner shown):

| view | fallback `y` | real logo `y` | drop |
|------|------|------|------|
| desktop 1440 | 15 | **52.4** | **37.4px** |
| mobile 390 | 10 | **41.8** | **31.8px** |

The drop decomposes into:
- **`RealityBanner` height (~31.75px)** — it renders for any non-live account
  (`tone !== "live"`: paper / no-account) and sits *above* the bar, pushing the
  logo down. Its presence depends on snapshot data that **does not exist during
  the loading screen**, so the fallback cannot predict it.
- **A desktop within-bar error**: the control row is ~43px tall (two-line
  ScopeSelector), so the 18px logo centers ~20.7px below the bar top, not the
  ~15px the old fallback assumed. (Mobile's within-row 10px was already correct.)

## Fix

`intro-canvas.tsx` only. The banner offset is unknowable on a cold load but can be
**remembered**:

1. **Persist** the real logo's measured top to `localStorage`
   (`st.introHdrY`, `{ d, m }` per breakpoint) every time the intro lands on it.
   The stored value already bakes in the banner height + true control-row height +
   fonts.
2. **Prime** `layout()`'s fallback `y` from that cache, so the wordmark assembles
   exactly where it will end up on any later fresh-tab intro (the tracking ease
   then travels ~0px — no drop). Falls back to the no-banner within-bar offset
   (desktop `20`, was `15`; mobile `10`) when never measured.
3. Keep the **every-frame re-measure** (from the mobile fix) as the self-healing
   safety net: a stale cache (account switched live↔paper) glides to the real logo
   and re-caches.

`localStorage` (not session) is used because the intro replays in a *new* tab
session, which shares `localStorage` but not `sessionStorage`. `x`/`w`/`h` are
unchanged — they already match the real responsive logo; only `y` is corrected.

An independent multi-agent design review converged on this same approach
(persist-real-y + fix the desktop constant) over the alternatives (a loading-time
DOM proxy and reserving banner space are no-ops — the wordmark is canvas-drawn at
`layout()` coordinates, and neither can know the banner during loading).

## Verification

Empirical (Chromium, dev server, `/api/dashboard` delayed 13s so the intro plays
over the loading screen past assembly):

- **Cold (no cache):** wordmark assembles at top **~19px** (near viewport top —
  the old high position); after load the real logo is at **y=52.4** and the cache
  is written **`{d:52}`**. ✓ (write path)
- **Primed cache `{d:52}` (returning user):** wordmark assembles at top **~51px** —
  at the real bar level, matching the real logo's 52.4 within ~1px. **No drop.** ✓

Gate: `npx tsc --noEmit` 0 · `npm run lint` 0 errors · `npm test` **3927 pass** ·
`npm run build` exit 0.

## Follow-ups

- **Cold first-ever visit** (empty cache, non-live account) still assembles at the
  no-banner `y` and glides down once as the logo mounts (a smooth ease now, not a
  hard jerk), then caches for next time. Optional hardening (deferred as it touches
  the per-candle flight timeline): gate a "hold liftoff until the real logo is
  measured" ONLY on a cold cache, so even the first visit assembles in place; the
  warm-cache common path stays byte-for-byte unchanged.
