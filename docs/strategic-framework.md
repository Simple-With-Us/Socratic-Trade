# The Strategy, in Plain English

**Audience:** A curious, college-educated reader who has *not* spent years
trading. No jargon is assumed; where a finance term is unavoidable it is
explained the first time it appears.

**Purpose:** Explain the *whole* idea behind this app — what it is trying to do,
how it decides what to buy or sell, how it learns, and (just as important)
**where it is weak, unproven, or could lose money.** This is meant to be honest,
not a sales pitch.

**Living document:** This file should be updated whenever the strategy actually
changes. If you tighten a risk rule, add a data source, fix a known weakness, or
discover a new one, edit the relevant section here *and* note it in the
changelog at the bottom. If a weakness listed here gets fixed, move it from
"Weaknesses" to "What we fixed" rather than silently deleting it — the paper
trail matters.

> One-sentence version: *An AI reads a lot of market data, argues with itself
> about whether a trade is a good idea, and only if it survives that argument does
> a set of hard-coded safety rules let a small order through — and the system
> keeps score so it can (slowly) get better.*

---

## 1. What this app actually is

It is a **dashboard plus an automated trading assistant** for the U.S. stock
market. It can:

- Watch a list of stocks you allow it to consider.
- Pull in data about those stocks (price, company health, news, etc.).
- Ask a large language model (LLM — the same kind of AI as ChatGPT) to *propose*
  trades, with reasons.
- Run those proposals through strict, non-AI **safety rules** before anything
  is allowed to happen.
- Either just *show you* the proposals, or — if you explicitly turn that on —
  *place small orders automatically*.
- Record everything it does and grade its own past decisions so it can improve.

### Two levels of "real money," on purpose

It is built so that **doing nothing dangerous is the default.** Execution mode
is derived purely from the `environment` of whichever broker account you've
connected — there is no local simulator and no separate "Test mode" toggle:

1. **Paper / sandbox account:** A practice environment hosted by a real broker
   (e.g. Alpaca Paper, Tradier Sandbox). Not production capital, but orders
   still go to that broker's system — realistic fills, latency, and market hours.
   With no connected account, the app **cannot place any orders** — there is no
   fake local-simulation fallback.
2. **Live / production brokerage:** A real account with real money (e.g. Alpaca
   live, Tradier production, Robinhood MCP). Orders can buy and sell only when
   every safety rule allows. Approving a production proposal may require typed
   confirmation tied to proposal, account, mode, and size so a stale tab cannot
   approve with an empty POST.

The app records execution mode (`broker/paper` or `broker/live`) on proposals,
fills, and portfolio snapshots so paper and live activity stay separate in
learning and accounting.

> **Honesty note:** Treat this system as **experimental**. It is not a product
> that promises profits, and nothing here is investment advice. Guardrails are
> owner preferences with overrides — not an immovable cage.

---

## 2. The core philosophy

Three beliefs shape every design decision:

1. **The AI is a smart analyst, not the boss.** The LLM is good at reading and
   reasoning over messy information, but it can also be confidently wrong
   ("hallucinate"). So it is allowed to *suggest*, but a layer of dumb,
   predictable, hand-written rules ("policy gates") has the final say on whether
   an order is allowed. The AI can never talk its way past those rules.

2. **Don't fight the weather.** Before looking at any single stock, the system
   looks at the overall market "climate" (calm vs. panicky, rising vs. falling).
   In a stormy market it demands more convincing before buying, leans toward
   safer choices, or considers betting against weak stocks.

3. **Keep score honestly, and learn slowly.** Every decision is logged with the
   conditions at the time. The system later grades itself on what actually made
   or lost money — not on how good the reasoning *sounded* — and uses that to
   suggest adjustments. Crucially, those adjustments are **suggestions a human
   approves**, not changes the machine makes to itself in the dark.

---

## 3. How a single decision gets made (the "six lenses")

When deciding about a stock, the system looks through six different "lenses." The
idea is that a trade should make sense from several angles, not just one — this
guards against tunnel vision.

### Lens 1 — The big picture (Macro / market regime)
*"What's the overall weather?"*
Looks at broad market trend (are big indexes like the S&P 500 going up or down?),
a "fear gauge" called the **VIX** (higher = more market anxiety), interest-rate
direction, inflation, jobs data, and big long-term themes (e.g. AI spending, the
rise of weight-loss drugs). The goal is to set the mood: be bolder when calm,
more cautious when stressed.

### Lens 2 — Is the business actually good? (Fundamentals)
*"Is this a healthy company at a fair price?"*
Looks at things like the price you pay relative to the company's earnings, whether
earnings are growing, how much cash the business generates, and how much debt it
carries. The aim is to favor solid companies that look reasonably priced — and to
spot deteriorating companies that might be good to bet *against*.

### Lens 3 — Is now a good moment? (Technicals)
*"Even if it's a good company, is the timing right?"*
Looks at price-chart patterns: trends, whether a stock looks "overbought" or
"oversold" (stretched too far up or down), and unusual jumps in trading volume.
This helps avoid buying something that's falling like a knife, or chasing
something that has already run too hot.

### Lens 4 — What's the news saying? (Sentiment & catalysts)
*"Is something happening right now that could move the price?"*
Scans headlines and news sentiment for events — earnings surprises, product news,
scandals — that the price may not have fully reacted to yet.

### Lens 5 — What is "smart money" doing? (Alternative data)
*"What are insiders and the well-connected doing?"*
Looks at signals that aren't in the everyday news: company insiders buying or
selling their own stock (required public filings), members of Congress disclosing
trades, short-selling pressure, and important regulatory filings. The system
**summarizes** these into one-line notes rather than dumping raw documents into
the AI (which would be slow and expensive).

### Lens 6 — The argument (Bull vs. Bear "red team")
*"Prove it's a bad idea."*
This is the distinctive part. Before a high-conviction trade is accepted, a
*second* AI prompt is told to do nothing but **attack** the idea — find every
reason it will fail. The original "bull" case must answer those objections. Only
trades that survive the fight move forward. Some objections are also checked by
plain hard-coded rules (a "deterministic bear") that can veto a trade outright,
no AI judgment involved.

> **How the lenses combine:** Lenses 1–5 are each turned into a numeric score
> (0–100). Those are blended using a **weighting matrix** (see next section) into
> an overall ranking. The AI sees these scores *and* the underlying evidence, and
> then reasons on top of them. The scores guide it; they don't replace its
> judgment, and neither one replaces the safety gates.

---

## 4. The weighting matrix (how much each lens counts)

By default the blend is roughly:

- **Fundamentals (is it a good business?): 30%**
- **Macro / market regime (what's the weather?): 25%**
- **Technicals (is the timing right?): 25%**
- **News / sentiment (any catalysts?): 20%**

> **Honesty note — these numbers are educated guesses.** They were chosen by
> reasoning, not proven by data. They are a *starting point*. The learning loop
> (next section) is supposed to recommend nudging them based on what actually
> works — but only a human can approve a change, and only after enough real
> results exist.

---

## 5. The learning loop (how it's supposed to get better)

This is the long-game ambition: a system that remembers, grades itself, and
improves.

### What it records
For every executed trade it saves far more than just profit/loss:
- The **market conditions at entry and exit** (e.g. "VIX was high, market falling").
- A **thesis tag** — the *type* of trade it was (e.g. "Breakout," "Value Play,"
  "Mean Reversion"), chosen from a fixed list so results can be grouped.
- **How much it hurt before it helped** (and vice versa): the worst paper loss
  and best paper gain reached while the trade was open. This reveals bad timing —
  e.g. consistently selling winners too early, or stubbornly holding losers.
- **Gross vs. net** results, so the cost of trading (fees, the gap between
  expected and actual price) is never hidden. This is meant to discourage
  hyperactive trading that looks profitable but isn't after costs.

### How it grades itself
It builds "scorecards": *Which thesis types actually make money? In which market
weather? In which sectors?* Because early on there are very few completed trades,
it uses a statistical technique (**Bayesian shrinkage**) that basically says
"don't trust a 100% win rate from only 2 trades" — small samples get pulled
toward a neutral assumption until there's real evidence.

### How it reflects (to save money and stay sharp)
Feeding the AI every old trade and every day's news would be expensive and
actually make its reasoning worse. So:
- Only **changes** are fed in (if interest rates didn't move since yesterday,
  don't repeat them).
- A background task periodically writes a short **"lessons learned"** note
  (e.g. *"Tech breakouts are failing in this choppy market"*) and only that
  compact lesson is injected into future decisions.

### How weights change (carefully)
When there's enough evidence, the system can *suggest* shifting the weighting
matrix (e.g. "trust fundamentals 5% less, technicals 5% more") or sector
targets. Strict guardrails apply:
- **At least 20 completed trades** before any weight-shift suggestion.
- **Small steps only** (no more than a 5-point change per factor at a time).
- **No wild concentration** (it won't dump everything into one sector).
- **Never automatic** — a human approves it in the dashboard.

> **Honesty note — the loop is not fully "closed" yet.** Today the learning
> mostly *informs the AI's reasoning* and produces *human-reviewed suggestions*.
> The suggested weight changes do **not** yet automatically change how big a
> position the system takes. So "self-tuning" is currently more "self-advising."
> That's a deliberate safety choice, but it means the system learns more slowly
> than the vision implies.

---

## 6. The safety net (the rules the AI cannot override)

This is the most important part for protecting real money. No matter what the AI
"decides," every potential real order must pass deterministic checks. Defaults:

- **Stocks only.** No options, crypto, or other complex instruments.
- **You must pre-approve the universe.** It can only consider stocks on a list
  you set (a custom list, or the S&P 500).
- **Tiny order size:** max **$10 per order** by default.
- **Daily cap:** max **$500** of trading value per day.
- **Concentration limit:** no more than **25%** of the portfolio in one stock.
- **Frequency cap:** max **10** real orders per day.
- **Kill switch:** one toggle immediately blocks all new orders.
- **System states:** it can be set to "halted," "close-only" (no new bets, only
  exits), or "liquidating" (only sells).
- **Stale-proposal expiry:** an old suggestion that's been sitting unapproved
  gets withdrawn automatically so it can't be acted on as if it were fresh.
- **Two authority levels:** *"LLM proposes"* (it only suggests; you act) vs.
  *"LLM decides"* (it can act within all the limits above).

There are also extra brakes for risky situations — e.g. tighter limits on
**short selling** (betting a stock goes down), because that has, in theory,
*unlimited* loss potential, and a cash-buffer rule so it doesn't deploy 100% of
the account.

---

## 7. When it runs

A background scheduler wakes up on a set interval (default hourly) and, only if
autonomy is enabled, the kill switch is off, and the U.S. market is open, runs
one decision cycle. It won't act overnight when nothing can be traded anyway.

---

## 8. Where the data comes from (and why that matters)

The system is built to run **for free** if needed: it always has a no-API-key
floor (Yahoo Finance) so every stock gets *real* numbers or shows a blank — it
**never invents a number to fill a gap.** Optional paid/keyed sources add depth
(company fundamentals, news sentiment, economic data, smart-money signals, and a
searchable archive of filings).

> **Honesty note:** A core design rule is *never label fabricated data as real,
> and never show a fake number next to a real one.* If a value isn't available,
> the cell is blank or marked "n/a." This is good for trust, but it also means
> on the free tier the system is often working with **partial information.**

---

## 9. Honest weaknesses, limits, and risks

This section is the point of the document. Read it.

### About the AI itself
- **It can be confidently wrong.** The bull/bear debate and the hard safety
  rules reduce this risk but do **not** eliminate it. An AI can construct a
  persuasive, well-reasoned case for a bad trade.
- **It can be inconsistent.** Ask the same question twice and the reasoning may
  differ. Settings are tuned to reduce this, but it's a property of the tool.
- **Its "lessons" can be wrong too.** The reflection summaries are themselves
  AI-generated; a misleading lesson could nudge future decisions the wrong way.

### About the data
- **Free data is delayed and incomplete.** Default quotes can be delayed, not
  live. Some "smart money" feeds are rate-limited and frequently return nothing,
  so those edges are often **absent**, not actively working.
- **The stock list is a static snapshot.** The built-in S&P 500 list was captured
  on a specific date and isn't refreshed automatically, so it can drift out of date.
- **Sentiment scoring is crude.** News sentiment is still largely keyword-based,
  not a sophisticated language model trained on finance. Upgrading it is a known
  to-do, not a finished feature.

### About the strategy logic
- **The factor weights are unproven guesses** (see Section 4).
- **There is no real backtester.** The strategy has **not** been rigorously
  tested against decades of historical data to see how it *would* have performed.
  It is validated mostly by running forward in Paper mode. This is a **major**
  limitation: a strategy can look fine in a few weeks of calm markets and fall
  apart in a crash. Treat any short-term results with heavy skepticism.
- **Cold start.** With fewer than 20 completed trades, the "learning" is barely
  learning. Early behavior reflects the initial guesses, not earned wisdom.
- **Overfitting risk.** As it adapts to recent conditions, it may get very good
  at fighting the *last* war and be caught off guard when the market regime
  changes.
- **Tiny size hides reality.** $10 orders keep it safe, but at that size,
  trading costs and price slippage dominate, so the profit/loss signal it learns
  from is **noisy** and may not scale to larger sizes.
- **Short selling is high-risk and not fully proven.** Guardrails exist, but the
  accounting and broker behavior for short/cover trades are flagged in the code
  as needing more verification before being trusted with real money.
- **Candidate weight changes are still not fully proven out-of-sample.** The app
  has an IC/OOS harness, but proposed scoring-weight patches still need a true
  candidate-vs-current-policy validation path before they should be treated as
  proven improvements.

### About the plumbing
- **It runs as a single local process.** The scheduler isn't distributed or
  highly available; if the machine is off, nothing runs. It's a personal tool,
  not hardened infrastructure.
- **No market-holiday calendar.** It knows weekends and daily hours but does not
  model holidays, so it may attempt a cycle on a closed-for-holiday day.
- **The database is local SQLite.** There's a documented backup/replication path,
  but the default footprint is one file on one machine.
- **Cost-saving shortcuts can drop context.** To keep the AI affordable, the
  system trims what it sends. Occasionally something useful gets trimmed.

### The bottom line
- **No edge is guaranteed.** Markets are highly competitive and largely efficient.
  Many smart, well-funded players are doing this professionally. A free-data,
  small-size, experimental system should be assumed to have **no proven edge**
  until results over a long period and varied market conditions say otherwise.
- **You can lose money in real mode.** The safety rules cap *how fast* and *how
  much*, but they cannot make a losing strategy profitable.

---

## 10. Glossary (plain definitions)

- **LLM / language model:** AI that reads and writes text and can reason over
  information (like ChatGPT). Here it analyzes data and proposes trades.
- **Policy gates / deterministic rules:** Fixed, hand-written if-then rules (no
  AI) that decide whether an order is allowed. The final authority.
- **Long / Short:** "Long" = betting a price goes *up* (normal buying). "Short"
  = betting a price goes *down*; riskier because losses can grow without a
  natural ceiling.
- **VIX:** A widely watched "fear gauge." Higher means the market expects bigger
  swings.
- **Fundamentals:** Measures of a company's actual business health (earnings,
  cash, debt, growth).
- **Technicals:** Patterns in the price chart and trading volume used for timing.
- **Sentiment:** The mood implied by news and headlines.
- **Regime:** The overall "weather" of the market (calm/stormy, rising/falling).
- **Thesis tag:** A label for *why* a trade was made, so similar trades can be
  graded together.
- **MAE / MFE:** The worst (Adverse) and best (Favorable) paper swing a trade
  experienced while open — used to judge timing.
- **Backtest:** Simulating a strategy on historical data to estimate how it
  would have done. (Notably, a rigorous one is **missing** here.)
- **Slippage:** The difference between the price you expected and the price you
  actually got.
- **Bayesian shrinkage:** A statistics technique that distrusts conclusions drawn
  from very few examples until more evidence arrives.

---

## Changelog

- **2026-07-03** — Removed the local "Test mode" simulator and `policy.paperMode`
  from the codebase (see `docs/rollouts/2026-07-03-remove-paper-default-test-mode.md`).
  Updated the "Three levels of real money" section to the two modes that
  actually exist now — Paper and Brokerage/Live — both derived purely from a
  connected broker account's `environment`; with no connected account the app
  cannot place any orders (no fake local-simulation fallback).
- **2026-06-23** — Expert safety/UI pass: persisted execution mode separately
  from paper/live source buckets; hardened Alpaca bracket-dollar orders; kept
  close-only protective stop/reconciliation maintenance alive; added server-side
  typed confirmation for live approvals; made the mode banner compact-only
  instead of hideable; added a readiness strip; tightened consent failure
  behavior; repaired Litestream command/env drift; and fixed vector credential
  lookup so raw app user IDs are used for key resolution while sanitized IDs
  remain in vector metadata/filters. Remaining weaknesses now explicitly include
  candidate-vs-baseline OOS validation and richer RAG/provider diagnostics.
- **2026-06-21** — Initial plain-English framework written, summarizing the
  design across `PLAN.md`, `PROJECT.md`, `README.md`, and the phase docs
  (especially `docs/phase-7-strategy.md` for the learning loop, `docs/phase-4-…`
  for scoring, `docs/phase-1-…` for the autonomy loop). Honest-weaknesses section
  reflects state as of this date: advisory-only weight shifts, no rigorous
  backtester, free-tier data gaps, crude sentiment, short-selling not fully
  proven, single-process scheduler, no holiday calendar.
