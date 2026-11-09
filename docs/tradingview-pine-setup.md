# TradingView → app: technical-signal bridge (Pine Script + webhook)

This is the operator guide for the **technical-signal** web source — the one signal
category the rest of the stack can't produce (RSI/MACD/MA crossovers need price-history
bars; everything else is a snapshot or cross-sectional aggregate). It has **two
interchangeable producers** that fill the same per-symbol dataset:

| Producer | Mode | Cost | How it runs |
| --- | --- | --- | --- |
| **TradingView** (push) | `TECHNICAL_SOURCE=tradingview` (default) | paid plan / trial | Pine `alert()` → webhook → app |
| **In-house** (pull) | `TECHNICAL_SOURCE=computed` | free | daily OHLC (Yahoo/Stooq) → `computeTechnicals()` |

Downstream is identical for both — the signal overlays onto the market scan, lifts the
`momentum` factor, pulls strong bullish names into the candidate set, emits a prompt
bulletin, and is captured in the per-run evidence digest so the learning loop measures
whether it pays. **Swap producers with one env var; nothing downstream changes.**

> Is a ~2–3 week trial enough? Enough to validate the **integration and signal quality**
> end-to-end (latency, format, whether the technical lens surfaces names the fundamental
> screen misses). **Not** enough to prove **profitability** — the learning loop gates
> weight shifts at 20 closed lots, which a few weeks of paper swing trades won't reach.
> Plan: run TradingView during the trial; when it ends, flip to `computed` (free) — you
> keep the Pine scripts and lose nothing downstream. Re-subscribe only if the data pays.

---

## 1. Configure the app (env)

Add to `.env.local` (or your shell), then restart the app:

```bash
# Required for the TradingView producer — the shared secret embedded in every alert body.
TRADINGVIEW_WEBHOOK_SECRET="<a long random string you choose>"

# Optional. If set, only these source IPs are accepted (comma-separated). Note: behind a
# tunnel the visible IP is the tunnel's, so leave this UNSET when using cloudflared/ngrok.
# TRADINGVIEW_WEBHOOK_IPS="52.89.214.238,34.212.75.30,52.32.178.7,52.89.214.238"

# Producer selection (default tradingview). Switch to "computed" after the trial.
# TECHNICAL_SOURCE=tradingview

# Optional kill switch + tuning.
# WEB_SOURCE_TECHNICAL=off            # disable the whole technical source
# WEB_SOURCE_TECHNICAL_TTL_MS=129600000   # how long a signal stays fresh (default 36h)
```

**Security:** the route **fails closed** — if `TRADINGVIEW_WEBHOOK_SECRET` is unset, every
webhook is rejected with 401. The secret is verified in constant time. TradingView does
not sign payloads, which is why the secret lives in the alert body.

## 2. Expose the local app (tunnel)

TradingView's servers must reach your machine. Free option (no account needed):

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a public URL like `https://random-words.trycloudflare.com`. Your webhook URL is
that origin + the route path:

```
https://random-words.trycloudflare.com/api/webhooks/tradingview
```

(ngrok works too: `ngrok http 3000`. Both give a fresh URL each restart on the free tier —
just update the alert's webhook URL when it changes.)

## 3. Add the Pine script

1. Open any chart on tradingview.com → bottom panel → **Pine Editor** tab.
2. Paste the script below → **Save** (name it "Agentic Signal Bridge") → **Add to chart**.
3. Set the **Shared secret** input to the exact value of `TRADINGVIEW_WEBHOOK_SECRET`.

```pinescript
//@version=6
indicator("Agentic Signal Bridge", overlay=true)
secret  = input.string("CHANGE_ME_LONG_RANDOM", "Shared secret (must match app)")
rsiLen  = input.int(14, "RSI length")
rsiBuy  = input.int(30, "RSI oversold (long trigger)")
rsiSell = input.int(70, "RSI overbought (short/exit trigger)")
fastLen = input.int(50, "Fast SMA")
slowLen = input.int(200, "Slow SMA")
r       = ta.rsi(close, rsiLen)
smaFast = ta.sma(close, fastLen)
smaSlow = ta.sma(close, slowLen)
goldenCross = ta.crossover(smaFast, smaSlow)
deathCross  = ta.crossunder(smaFast, smaSlow)
rsiReclaim  = ta.crossover(r, rsiBuy)
rsiFade     = ta.crossunder(r, rsiSell)
bullish = goldenCross or rsiReclaim
bearish = deathCross or rsiFade
sigName = goldenCross ? "sma50_200_golden_cross" : rsiReclaim ? "rsi_reclaim_oversold" : deathCross ? "sma50_200_death_cross" : "rsi_fade_overbought"
action  = bullish ? "bullish" : "bearish"
payload = '{"secret":"' + secret + '","symbol":"' + syminfo.ticker + '","exchange":"' + syminfo.exchange + '","action":"' + action + '","signal":"' + sigName + '","price":' + str.tostring(close) + ',"rsi":' + str.tostring(r, "#.##") + ',"tf":"' + timeframe.period + '","bar_time":' + str.tostring(time) + '}'
if bullish or bearish
    alert(payload, alert.freq_once_per_bar_close)
plot(smaFast, "SMA50", color.new(color.aqua, 0))
plot(smaSlow, "SMA200", color.new(color.orange, 0))
```

The app also accepts an optional precomputed `"score"` (0–100) in the payload; when it's
absent the app maps `action` → score (bullish 70 / bearish 30 / neutral 50). The payload
fields it reads: `secret, symbol, action, signal, score?, price?, rsi?, tf?, bar_time`.

## 4. Wire the alert + webhook

1. With the indicator on the chart, press **Alt+A** (or open the **Alerts** panel → **Create Alert**).
2. **Condition** → *Agentic Signal Bridge* → **"Any alert() function call"**.
3. **Notifications** tab → check **Webhook URL** → paste your tunnel URL + `/api/webhooks/tradingview`.
4. **Expiration** → *Open-ended* → **Create**.
5. Repeat per symbol you want covered — each chart/symbol needs its own alert. (Alert
   count is capped by your TradingView plan tier.)

### Verify it's flowing
- TradingView → **Alerts log** shows the alert firing on bar close.
- App audit log shows a `technical_signal_ingest` event; rejects show
  `tradingview_webhook_rejected`.
- The symbol's next market scan carries a `Technical: … [TradingView]` bulletin and a
  lifted `momentum` sub-score.

Quick local sanity check (replace the secret):
```bash
curl -X POST http://localhost:3000/api/webhooks/tradingview \
  -H 'content-type: application/json' \
  -d '{"secret":"<your secret>","symbol":"AAPL","action":"bullish","signal":"rsi_reclaim_oversold","price":210.5,"bar_time":1718000000000}'
# → {"ok":true,"symbol":"AAPL","deduped":false}
```

## 5. After the trial: switch to free computed mode

Set `TECHNICAL_SOURCE=computed` and restart. The app then pulls daily OHLC (Yahoo chart,
Stooq fallback — both free, no key) for the current scan candidates and computes the same
RSI/MACD/MA reads in-house. You lose intrabar/real-time push and TradingView's indicator
breadth, but keep daily technicals for free, and the learning loop keeps accumulating
across both producers. Keep the Pine scripts saved on your TradingView account for an easy
re-subscribe later if the technical signal proves it pays.

## Reference
- Receiver route: `app/api/webhooks/tradingview/route.ts`
- Connector + both producers: `src/lib/web-sources/technical.ts`
- Pure indicators: `src/lib/indicators.ts`
- Overlay + scoring wiring: `src/lib/market.ts` (`hasNotableWebSignal`, overlay block, `momentumScore`)
