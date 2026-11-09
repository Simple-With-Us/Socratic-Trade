# Appendix C — Best-in-Class Pattern Research

> Raw output from the large-team redesign workflow (48 agents, 2026-07-01). Preserved verbatim for provenance; the canonical synthesis lives in ../settings-navigation-redesign.md.

### research:consumer-apps
I have enough verified detail across all five apps. Here is the patterns brief.

---

# Consumer Investing App Patterns Brief: Navigation, Settings & Multiple Accounts

Scope: Robinhood, Public.com, eToro, Webull, SoFi Invest. Findings verified against 2025-2026 web sources where available; where sources were thin (Webull mobile specifics, eToro tab exactness), I supplement with expert knowledge of the current apps and flag it inline. Mobile apps are the reference surface (that's where consumer patterns are set).

## 1. Top-level navigation (tab bar count & labels)

The consistent pattern is a **bottom tab bar of 4-5 items**, kept deliberately small. Deep functionality (settings, account switching, statements) is pushed into a **"Menu"/profile hub** reached from a tab or a top corner, NOT given its own tab.

| App | Tab count | Tabs (labels) | Where "everything else" lives |
|-----|-----------|---------------|-------------------------------|
| **Robinhood** | 5 | **Menu, Search, Markets, Account, Cash** (Account is a person icon; portfolio/watchlist live under it) | Settings, statements, transaction history, and **account switching** all sit inside Account → Menu (3-bar). |
| **Public.com** | ~5 | Home/Portfolio, Explore/Search, (trade), Community, Menu | Top-left **Menu (≡)** opens the profile hub with the "All accounts" switcher and settings. |
| **eToro** | ~5 | **Watchlist, Portfolio, Discover, Feed (social), Menu/More** | Profile/settings in the More menu; social feed is elevated to a *primary* tab (unique to eToro). |
| **Webull** | ~5 | **Markets, Watchlists (+ quote bar), Trade, (Account/Overview), Menu** | **Menu tab** = settings, help center, messages, rewards, "all features." |
| **SoFi Invest** | Tab within super-app | Invest is one tab of the SoFi super-app (Bank / Invest / etc.); Invest overview shows one **card per account** | Global settings live at the SoFi app level; per-account entry is "View Account" per card. |

Takeaway: nobody exceeds 5 tabs. The tab bar is reserved for *frequent* verbs (view portfolio, search/discover, trade, cash/markets). Configuration is always one level down.

## 2. Where account switching lives

Universally, account switching is **NOT** a tab — it's an affordance inside the profile/account hub, usually top-corner-triggered:

- **Public.com**: top-left **Menu (≡)** → an **"All accounts"** box lists every account (brokerage, Traditional IRA, Roth IRA, Treasury/Bond sub-accounts); tap one to switch context. Clear "one login, many accounts" model.
- **Robinhood**: **Account (person icon) → Menu (3-bar)** to switch. Notably rate-limits switching to **once per trading day** — a compliance/risk guardrail worth noting. Up to **10 individual accounts** per user (limit includes deactivated).
- **SoFi**: no "switcher" per se — the Invest overview is a **list/stack of account cards**, and you drill into one via "View Account." Switching = navigating, not toggling.
- **eToro / Webull**: single primary trading account is the norm (plus paper-trading toggle); switching is less prominent because the multi-account surface is smaller.

Two distinct models emerge:
- **Global context switcher** (Public, Robinhood): the whole app rebinds to "the selected account."
- **Account-list-as-home** (SoFi): no persistent "current account"; you always pick from a list. Better when accounts are heterogeneous (bank + robo + self-directed).

## 3. Per-account vs global settings separation

The clean split every app converges on:

- **Global (user/login level):** profile, identity/KYC, security (2FA, biometrics), notifications, linked banks, tax documents, app appearance, support. Lives in the Menu/profile hub.
- **Per-account level:** the account's cash/buying power, positions, its own statements, its automation config, margin on/off, dividend reinvestment (DRIP), and — critically — its own **risk/mandate settings**. Reached *after* you've selected/entered that account.

SoFi makes this split most explicit: **Robo (Automated) vs Self-Directed (Active)** are separate account objects with separate settings; they even document that you *can't merge* them — the settings and mandate boundaries are hard. Public treats Treasury/Bond/Direct-Index as **sub-accounts** with their own rules that don't travel with a brokerage transfer.

## 4. How they present risk / automation

- **SoFi**: automation is a **first-class account type** (Robo Invest) with its own onboarding (risk questionnaire → portfolio tier) distinct from Active Investing. Automation config (recurring deposits, "Autopilot" paycheck splitting, direct-deposit routing) is surfaced in an **Autopilot hub** at the banking level, but *targets* a specific invest account. So: automation *rules* are global-ish, but *bound to* a named account.
- **eToro**: risk/automation is **CopyTrader** — you allocate capital to copy an investor; risk shows as portfolio allocation %, stop-copy thresholds, and per-copy risk indicators. Automation = "mirror this strategy," presented socially rather than as sliders.
- **Robinhood**: automation via recurring investments and Gold features; risk gating shows up as the **once-per-day account-switch limit**, margin toggles, and options-tier approval — i.e., risk is enforced as *permission tiers and rate limits*, not just displayed.
- **Webull / Public**: recurring investment plans, DRIP toggles; risk shown at order time (buying power, margin warnings) rather than as a standing "automation dashboard."

Pattern: automation is either **its own account type** (SoFi) or a **rule attached to an account** (recurring buys, copy). Nobody makes "automation" a free-floating global switch divorced from an account.

## 5. Concrete, reusable takeaways for a multi-account AI-trading app

1. **Cap the tab bar at 4-5; keep it verbs, not accounts.** Tabs like Dashboard, Scan/Explore, Proposals/Activity, Menu. Do **not** spend a tab on account switching or settings — every studied app pushes those into a Menu hub. (Robinhood, Webull, eToro, Public all do this.)

2. **Put the account switcher in a top-corner Menu with an "All accounts" list**, mirroring Public's model. Show every account with its balance and a one-line status (e.g., "Automation: ON, moderate"). Make the *currently active account* unmistakable in a persistent header/chip so users always know which account an AI action will hit — this is the single biggest safety issue for multi-account.

3. **Adopt a hard global-vs-per-account settings boundary.** Global: identity, security, notifications, API/broker keys, appearance. Per-account: mandate, risk limits, automation autonomy level, paper-vs-live, DRIP, position caps. When in doubt, if a setting changes *how trades are decided/placed*, it belongs to the account — because with an AI agent, a mis-scoped risk setting is a money bug. (SoFi's non-mergeable Robo/Active split is the model.)

4. **Model automation as a per-account property with an explicit autonomy tier**, SoFi-Robo-style, not a single global switch. Each account carries its own mode (e.g., Off / Suggest-only / Auto-with-guardrails / Full-auto) plus its own risk envelope. This matches SoFi treating automated vs self-directed as separate account objects, and it prevents "turned on automation globally, blew up the IRA."

5. **Build a rate-limit / cool-down guardrail into account context changes and automation toggles**, echoing Robinhood's once-per-trading-day switch limit. For an AI app, gate *going live*, *raising risk limits*, and *enabling full-auto* behind confirmations and cooldowns — cheap friction that prevents catastrophic fat-finger/agent-loop actions.

6. **Support heterogeneous account types with type-aware settings and sub-accounts.** Public's brokerage / IRA / Treasury / Direct-Index sub-account structure shows accounts aren't fungible: each type constrains what's allowed (contribution limits, transfer rules, eligible instruments). Your schema should let an account declare its type, and the UI should hide/disable actions the type forbids — especially important when an AI proposes trades it must not place in a given account.

7. **Give each account its own activity/statement/audit trail, reachable only after entering that account.** Every app scopes statements and transaction history to the selected account. For an AI app add an **agent-decision log per account** (why it proposed/placed each trade) in that same per-account drawer — this is your compliance and trust surface.

8. **Make risk legible at the moment of action, not just in settings.** Webull/Robinhood/Public all surface buying power, margin, and permission warnings *at order time*. For an AI app, every proposal card should show, inline, which account it targets, that account's remaining risk budget, and its mandate/regime — so the human approving isn't context-switching to verify safety.

## Sources

- [Robinhood — A New Way to Navigate Robinhood](https://robinhood.com/newsroom/a-new-way-to-navigate-robinhood/) (bottom tab bar: Menu, Search, Markets, Account, Cash)
- [Robinhood — Multiple investing accounts FAQ](https://robinhood.com/us/en/support/articles/multiple-investing-accounts-faq/) (up to 10 accounts; switch via Account → Menu; once-per-trading-day limit)
- [Public FAQ — How do I switch to my IRA account?](https://help.public.com/en/articles/10064041-how-do-i-switch-to-my-ira-account) ("All accounts" list under top-left Menu ≡)
- [Public FAQ — Can I have more than one account at Public?](https://help.public.com/en/articles/9307219-can-i-have-more-than-one-account-at-public) and [Individual Retirement Accounts](https://help.public.com/en/collections/10669349-individual-retirement-accounts) (IRA/Treasury/Bond/Direct-Index sub-accounts)
- [SoFi — Automated Investing (Robo)](https://www.sofi.com/invest/automated/) and [Can I combine Automated & Active accounts?](https://support.sofi.com/hc/en-us/articles/360039715052) (separate, non-mergeable account types; per-account cards; Autopilot hub)
- [Webull — General Platform Navigation](https://www.webull.com/help/faq/11033-General-Platform-Navigation) and [A Detailed Guide to Navigating the Webull App](https://markets.financialcontent.com/stocks/article/globeprwire-2026-6-9-a-detailed-guide-to-navigating-the-webull-app) (Markets/Watchlists/Trade/Menu tabs; Menu = settings/help/messages/rewards)
- [eToro — Portfolio Management, your new "Home"](https://www.etoro.com/news-and-analysis/etoro-updates/portfolio-management-advanced-filters-your-new-home-and-many-more-available-now/) and [What is the Portfolio?](https://help.etoro.com/s/article/what-is-the-portfolio) (Watchlist / Portfolio / Discover / Feed structure; CopyTrader)

**Note on source confidence:** Robinhood, Public, and SoFi navigation/multi-account details are directly source-confirmed. eToro's exact tab set and Webull's precise mobile tab labels/order are partly supplemented from my expert knowledge of the current apps (public docs describe the sections but not an authoritative tab-by-tab enumeration); the section *content* is confirmed, minor label/ordering specifics are best-effort.

### research:pro-terminals
I have everything I need. Writing the brief.

---

# Professional Trading Terminal IA & Settings Patterns Brief

Scope: thinkorswim (Schwab), Interactive Brokers TWS/Client Portal, TradingView, tastytrade. Grounded in web sources where cited; a few structural observations are flagged as expert knowledge.

## 1. Workspace / layout model

The consistent pattern is **separate the persistent shell from the swappable content**, and let power users save named arrangements they can switch instantly.

- **thinkorswim** splits the UI into three zones: a top-level row of ~8 named subpages (Trade, Analyze, Charts, Scan, etc.), a **persistent left sidebar of "gadgets"** (mini-widgets — quotes, news, level II, even games), and the main window. Gadgets are shortcuts/monitors that stay put while you move between subpages; the sidebar holds up to 15 gadgets and can be hidden entirely with one button. Whole arrangements save as named **Workspaces** ([toslc.thinkorswim.com – Left Sidebar](https://toslc.thinkorswim.com/center/howToTos/thinkManual/Left-Sidebar), [Workspaces](https://toslc.thinkorswim.com/center/howToTos/thinkManual/Getting-Started/Workspaces)).
- **TWS** offers two whole IA modes: **Mosaic** (integrated, linked-window grid for most users) and **Classic** (dense standalone windows for advanced/legacy). One product, two complexity tiers ([TWS User Guide – Mosaic](https://www.interactivebrokers.com/en/software/tws/usersguidebook/mosaic/the_mosaic_interface.htm), [Mosaic Cheat Sheet](https://www.interactivebrokers.com/download/CheatSheet_TWSMosaic_944.pdf)).
- **TradingView** makes the **saved layout the unit of the workspace** — chart look, indicators, drawings, and settings bundle into a named layout you switch between (swing vs. intraday), with multi-chart grids up to NxN. Critically, it keeps **layouts, watchlists, alerts, and indicator templates as orthogonal saved objects** — a layout is explicitly "not the same as" a watchlist or alert ([TradingView – Layouts quick guide](https://www.tradingview.com/support/solutions/43000746975-tradingview-layouts-a-quick-guide/), [Multi-chart layouts](https://www.tradingview.com/support/solutions/43000629990-leveraging-multi-chart-layouts-in-your-analysis/)).
- **tastytrade** uses the simplest model: **top-level tabs (Dashboard, Trading, Manage)** with a resizable panel grid and a 2×2 tastycharts grid ([tastytrade – Desktop Platform Overview](https://support.tastytrade.com/support/s/solutions/articles/43000435198), [Web Platform Overview](https://support.tastytrade.com/support/s/solutions/articles/43000686118)).

**Takeaway pattern:** a fixed navigational spine (tabs or subpages) + a persistent monitor rail + a content area whose full state is saveable as named presets. Density lives inside panels, not in the navigation.

## 2. How dense config is organized

**Categorized tree + search + progressive disclosure** is the near-universal answer to "hundreds of settings without overwhelm."

- **TWS Global Configuration** is the archetype: a **left-hand collapsible tree** (expand `+` to reveal sub-pages) drives a right-hand settings pane. High-level sections stay collapsed by default (progressive disclosure), and a **search/filter box** lets you jump to a setting without knowing the tree path ([IBKR – Intro to Global Configuration](https://www.interactivebrokers.com/campus/trading-lessons/intro-to-global-configuration/)). It reaches this scale precisely because it is a searchable tree, not a flat wall of toggles.
- **tastytrade** keeps config **local to the object it affects**: column choices live behind a **gear icon on that panel's header**, using a two-list "Displayed / Not Displayed" transfer picker rather than a global preferences dump ([tastytrade – Adding columns](https://support.tastytrade.com/support/s/solutions/articles/43000435347)). Global settings are a short list (theme, ticket defaults, columns, sounds).
- **thinkorswim** likewise uses a **per-gadget gear** ("Customize gadgets" dialog) for a compact add/remove/reorder list, keeping arrangement config next to the thing being arranged ([toslc – Left Sidebar](https://toslc.thinkorswim.com/center/howToTos/thinkManual/Left-Sidebar)).
- **TradingView** scopes config by object too: a **grouped Settings dialog** per chart (headers derive from a `group` value), separate from the layout-sync menu that controls which properties (symbol, interval) propagate across a multi-chart grid ([TradingView – Layouts, charts, drawings](https://www.tradingview.com/support/solutions/43000692404-layouts-charts-drawings-indicators-and-their-interaction/)).

**Two coexisting config strategies:** (a) *global* dense settings → searchable categorized tree (TWS); (b) *contextual* settings → gear icon on the panel/object header, opening a small scoped dialog (everyone else). Most surface reduction comes from choosing (b) wherever a setting only affects one panel.

## 3. Multi-account handling

The dominant pattern is a **single global account selector** in the shell that scopes everything downstream, with **grouping/aliasing** to tame many accounts.

- **TWS**: linked accounts all appear in one **account-selector dropdown**; selecting an account (or `All`) scopes positions/orders/portfolio views. For advisors with many accounts, TWS adds **Groups** (allocate by liquidation value/equity) and **Profiles** (explicit % ratios), chosen from an **allocation dropdown at order entry** — and lets you **replace account numbers with human aliases** ([IBKR – Create account group for allocation](https://www.interactivebrokers.com/en/software/tws/usersguidebook/financialadvisors/create_an_account_group_for_share_allocation.htm), [Navigating Advisor Setup](https://www.interactivebrokers.com/campus/trading-lessons/navigating-the-tws-advisor-setup-window/)). This is the richest model: select-to-scope for viewing, allocate-at-entry for acting.
- **tastytrade / thinkorswim / TradingView** (retail-leaning): a simpler **account-switcher dropdown** scopes the whole view; the order ticket inherits the currently selected account rather than exposing per-order allocation. (Expert knowledge; consistent with their retail positioning.)

**Takeaway pattern:** one authoritative account picker in the persistent shell scopes read views; only expose *per-order* account allocation (groups/profiles) as an advanced tier for users who genuinely manage many accounts — don't put allocation UI in every ticket by default.

## 4. Progressive disclosure & complexity tiering (cross-cutting)

- **Mode tiers**: TWS Mosaic vs Classic — same product, a "guided" default and an "everything exposed" expert mode.
- **Default-collapsed trees**: config sections ship collapsed; search short-circuits the hierarchy.
- **Object-scoped gears**: complexity is hidden behind the header of the exact panel it configures, not aggregated into one mega-dialog.
- **Named presets as the escape valve for density**: workspaces (ToS), layouts/templates (TradingView), advisor profiles (TWS) let users *bank* a complex arrangement once and recall it, so the everyday UI stays lean.

## 5. Concrete takeaways for reducing surface count while keeping power

1. **Split the shell from the content.** Keep a small fixed navigation spine (3–8 tabs/subpages) plus one persistent monitor rail; make everything else swappable content whose full state saves as a **named preset** (ToS Workspaces / TradingView Layouts). New capability adds a preset, not a nav item.
2. **Push config to where it applies — a gear on the panel header, not a global settings page.** Column pickers, panel options, and per-widget prefs should open a small scoped dialog (tastytrade/ToS gear pattern). Reserve the global settings area for truly cross-cutting prefs.
3. **When global settings must be dense, use a searchable categorized tree that ships collapsed.** Copy TWS Global Config: left tree + right pane + a filter box. Search lets power users bypass the hierarchy; collapse-by-default protects newcomers. This scales to hundreds of settings without a flat wall.
4. **Keep orthogonal concepts as separate saved objects.** TradingView's discipline — layout ≠ watchlist ≠ alert ≠ indicator template — prevents one bloated "settings" blob and lets users mix-and-match. Model your saved artifacts the same way instead of one monolithic profile.
5. **Offer a complexity tier, not just one UI.** A "simple/guided" default plus an "advanced/classic" mode (TWS Mosaic vs Classic) covers both audiences without cramming expert controls into the beginner path. Gate advanced surfaces behind an explicit opt-in.
6. **One global account selector scopes the whole app; make per-order allocation an advanced-only surface.** Most users need select-to-scope viewing (tastytrade); only multi-account/advisor users need groups/profiles at order entry (TWS). Don't tax every ticket with allocation UI — and support **human aliases** over raw account numbers.
7. **Use two-list transfer pickers for "which of many fields to show."** tastytrade's Displayed/Not-Displayed column picker scales to dozens of fields far better than dozens of individual checkboxes, and reuses one mental model everywhere columns appear.
8. **Give density an escape valve via presets + hide toggles.** A one-click "hide sidebar/rail" (ToS) plus recallable saved arrangements means the same UI serves a minimalist and a 15-gadget power user without a settings change — the user tunes visible surface on demand rather than you guessing a default.

## Sources
- [thinkorswim Learning Center – Left Sidebar](https://toslc.thinkorswim.com/center/howToTos/thinkManual/Left-Sidebar)
- [thinkorswim Learning Center – Workspaces](https://toslc.thinkorswim.com/center/howToTos/thinkManual/Getting-Started/Workspaces)
- [IBKR Campus – Intro to Global Configuration](https://www.interactivebrokers.com/campus/trading-lessons/intro-to-global-configuration/)
- [TWS User Guide – The Mosaic Interface](https://www.interactivebrokers.com/en/software/tws/usersguidebook/mosaic/the_mosaic_interface.htm)
- [IBKR – Mosaic Cheat Sheet (PDF)](https://www.interactivebrokers.com/download/CheatSheet_TWSMosaic_944.pdf)
- [IBKR – Create an Account Group for Share Allocation](https://www.interactivebrokers.com/en/software/tws/usersguidebook/financialadvisors/create_an_account_group_for_share_allocation.htm)
- [IBKR Campus – Navigating the TWS Advisor Setup Window](https://www.interactivebrokers.com/campus/trading-lessons/navigating-the-tws-advisor-setup-window/)
- [TradingView – Layouts: a quick guide](https://www.tradingview.com/support/solutions/43000746975-tradingview-layouts-a-quick-guide/)
- [TradingView – Leveraging multi-chart layouts](https://www.tradingview.com/support/solutions/43000629990-leveraging-multi-chart-layouts-in-your-analysis/)
- [TradingView – Layouts, charts, drawings, indicators](https://www.tradingview.com/support/solutions/43000692404-layouts-charts-drawings-indicators-and-their-interaction/)
- [tastytrade – Desktop Platform Overview](https://support.tastytrade.com/support/s/solutions/articles/43000435198)
- [tastytrade – Web Platform Overview](https://support.tastytrade.com/support/s/solutions/articles/43000686118)
- [tastytrade – Adding columns in the platform](https://support.tastytrade.com/support/s/solutions/articles/43000435347)

Note: Retail multi-account/order-ticket behaviors for tastytrade, thinkorswim, and TradingView in section 3, and the "object-scoped gear" generalization, are stated from expert knowledge where sources confirmed the mechanism but not every per-platform nuance.

### research:algo-platforms
I have enough to synthesize. All findings below are from web search (cited).

---

# Automated / Robo Trading Platform Research

How six automated-strategy and robo platforms model a strategy-as-object, bind it to accounts, gate automation, and surface "the bot is doing X." All findings from web search (cited inline).

## Per-platform notes

**Composer.trade (now Composer by SoFi)** — The strategy object is a **"Symphony"**: a self-contained, named, no-code visual algorithm (conditionals/triggers on price, return, moving averages, RSI) that you can backtest, browse in a public "Symphony Database," and **invest a dollar amount into**. A single brokerage account (Alpaca) can hold **multiple symphonies simultaneously**, and the portfolio view shows which positions came from which symphony vs. direct/manual trades. Automation is gated by cadence and mode: you choose **daily/weekly/monthly** evaluation, or **threshold trading** (trade only when an asset's weight drifts out of a set band, e.g. ±10%); Pro users opt into auto-execution, and trades batch in a fixed daily window (3–4pm). Manual market orders and immediate liquidation coexist with the automation. [Composer](https://www.composer.trade/), [How Symphony Trading Works](https://help.composer.trade/article/65-how-does-composer-trade), [Threshold trading](https://help.composer.trade/article/76-threshold-trading), [Trading Period](https://help.composer.trade/article/63-trading-period)

**QuantConnect** — The strategy object is a **project/algorithm** (code). Binding to an account is an explicit **"Deploy Live"** step: pick brokerage (IBKR, Schwab, etc.), enter credentials, and it runs on co-located servers; cash syncs with the brokerage daily at 7:45am ET. The **paper→live gate is a first-class ritual** — QuantConnect Paper Trading runs the same algo on live data with fictional capital to confirm the backtest wasn't overfit before risking money. "The bot is doing X" is a rich **live results dashboard**: equity curve, holdings, trades, a **runtime-statistics banner**, and a **Logs tab** (UTC-timestamped: deployed, order sent, error, quit). On runtime error it stops and emails you, with optional auto-restart (5 tries). [Deployment](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/deployment), [Results](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/results), [Paper Trading](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/brokerages/quantconnect-paper-trading)

**Alpaca (dashboard/API)** — Not a strategy-object platform; it's the **execution substrate** others sit on. Its key design lesson is the **paper/live boundary**: identical endpoints, order types, market data, and code path — going live is "literally a one-line configuration change" (swap API key + endpoint). Paper and live are **separate accounts with separate keys** (up to 3 simulated accounts; one approved live account). It explicitly documents where the illusion breaks (real fills/liquidity, short/margin costs) so users don't over-trust paper. [Paper Trading](https://docs.alpaca.markets/us/docs/paper-trading), [Start Paper Trading](https://alpaca.markets/learn/start-paper-trading)

**Wealthfront** — The strategy object is a **portfolio tied to a single Automated Investing Account**, parameterized by a **Risk Score (1–10)** derived from a questionnaire, which maps to a stock/bond allocation (10 = 95% stocks, 1 = 80% bonds). Automation is **fully autonomous, no per-trade approval**: daily drift monitoring, tax-aware rebalancing, dividend reinvestment, and daily tax-loss harvesting — but with a **built-in guardrail** ("only realize gains when benefit outweighs estimated tax cost"). The "preset" is the risk score + portfolio type (Classic, expert-built, Smart Beta). [Investment Methodology](https://research.wealthfront.com/whitepapers/investment-methodology/), [Rebalancing](https://support.wealthfront.com/hc/en-us/articles/209353766)

**Betterment** — The strategy object is a **goal**, not just a portfolio. Each goal carries a **type** (Retirement, Major Purchase, Emergency Fund, General Investing, …) that changes behavior, plus a **glide path** that auto-adjusts allocation more conservative over time. Same account can hold multiple goals, each with its own risk/timeline. Automation is autonomous with an **opt-in "auto-adjust"** toggle for the glide path. The goal-type presets encode intent → behavior (a Major Purchase goal glides to near-zero risk at the date; Retirement stays higher). [Glide path](https://help.business.betterment.com/hc/en-us/articles/115004256586), [Auto-Adjust Disclosure](https://www.betterment.com/legal/auto-adjust-disclosure)

**Schwab Intelligent Portfolios** — Strategy object = an **"Investor Profile"** from a goals/risk/timeline questionnaire, which auto-configures ~20 ETFs from a 51-ETF menu. Automation is autonomous with an explicit, **stated rebalancing rule** (daily check-ins; rebalance when an asset class drifts **>5% from target**) — the *threshold is a disclosed, legible number*, which builds trust. [Automated Investing](https://www.schwab.com/intelligent-portfolios), [FAQs](https://www.schwab.com/automated-investing/faqs)

---

## 5–8 takeaways for presenting per-account AI strategy + presets

1. **Make the strategy a first-class named object with its own lifecycle.** Composer's "Symphony," QuantConnect's "algorithm," Betterment's "goal" — each is a nameable, backtestable, save/share-able thing distinct from the account. For our per-account AI strategy, give it a name, a thesis, an editable spec, and a backtest/preview, so the user reasons about "this strategy" not "my settings."

2. **Model strategy↔account as many-to-one with clear provenance.** Composer lets several symphonies run in one Alpaca account and **labels which positions came from which symphony vs. manual trades**. Our per-account view should attribute every holding/order to the strategy (or preset) that produced it, and separate AI-driven from hand-placed activity.

3. **Presets should encode intent, not just parameters.** Betterment's goal *types* and Schwab's *Investor Profile* and Wealthfront's *Risk Score 1–10* translate a human intent (retire, buy a house, "aggressive") into concrete behavior. Ship named presets ("Conservative income," "Aggressive momentum") that map to explicit, visible risk/threshold parameters — not raw sliders alone.

4. **Gate automation with an explicit, ritualized paper→live boundary.** QuantConnect and Alpaca both treat live-deployment as a deliberate act (Deploy Live / swap keys) after paper validation, and Alpaca documents *where paper diverges from live*. Keep Paper/Test the default (this repo already does), make "arm live automation" a distinct, confirmable step, and be honest about simulation limits — never present sim fills as if they were real.

5. **Offer a spectrum of automation gating, not a binary.** Real platforms range from full autonomy (Wealthfront/Betterment/Schwab, no per-trade approval but with disclosed guardrails) to cadence/threshold gating (Composer: daily/weekly/monthly or drift-band) to manual approval. Expose the analogous knobs per account: auto-execute vs. propose-for-approval, evaluation cadence, and a drift/threshold band that only trades when breached.

6. **Show "the bot is doing X" as a live status surface with a timestamped action log.** QuantConnect's live dashboard (equity curve, holdings, runtime-statistics banner, UTC-timestamped Logs: deployed / order sent / error / quit) is the gold standard. Our dashboard should show current strategy state (running/paused/errored), next scheduled evaluation, positions with attribution, and a chronological log of AI decisions and orders — including *why* (thesis tag / regime).

7. **Publish the guardrail thresholds as concrete, legible numbers.** Schwab's ">5% drift triggers rebalance," Wealthfront's "only realize gains when benefit > estimated tax cost," Composer's "±10% threshold band" all make automation feel safe by being *specific and disclosed*. Surface our risk/policy limits (daily notional, drift band, regime gates) as visible numbers the user can see the bot respecting.

8. **Give autonomy an "off switch" and safe defaults.** Every platform pairs autonomy with a stop/liquidate path (Composer's immediate liquidation, QuantConnect's error-stop + email, Betterment's opt-in auto-adjust). Pair per-account automation with one-click pause/flatten, error-driven auto-pause with notification, and conservative defaults (Paper mode, propose-not-execute) until the user explicitly arms it.

**Sources:** [Composer](https://www.composer.trade/) · [Composer – How Symphony Trading Works](https://help.composer.trade/article/65-how-does-composer-trade) · [Composer – Threshold trading](https://help.composer.trade/article/76-threshold-trading) · [Composer – Trading Period](https://help.composer.trade/article/63-trading-period) · [QuantConnect – Deployment](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/deployment) · [QuantConnect – Live Results](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/results) · [QuantConnect – Paper Trading](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/brokerages/quantconnect-paper-trading) · [Alpaca – Paper Trading](https://docs.alpaca.markets/us/docs/paper-trading) · [Wealthfront – Investment Methodology](https://research.wealthfront.com/whitepapers/investment-methodology/) · [Wealthfront – Rebalancing](https://support.wealthfront.com/hc/en-us/articles/209353766) · [Betterment – Glide path](https://help.business.betterment.com/hc/en-us/articles/115004256586) · [Betterment – Auto-Adjust Disclosure](https://www.betterment.com/legal/auto-adjust-disclosure) · [Schwab Intelligent Portfolios](https://www.schwab.com/intelligent-portfolios) · [Schwab – FAQs](https://www.schwab.com/automated-investing/faqs)

### research:scope-switchers
I have thorough coverage across all seven products. Synthesizing now.

---

# Scope switchers & scope-layering in best-in-class SaaS

Research on where scope switchers live, how apps signal current scope, how they layer settings, and how they prevent wrong-scope mistakes — with takeaways for an app with **connected-account scope + user-global scope + reusable presets**. Web-searched where noted; a few structural claims are expert knowledge (flagged).

## Per-product findings

**Stripe (test vs live / accounts).** The mode toggle sits **top-left, persistent on every page**, and is **color-coded** (orange = test, blue = live) so the mode is legible regardless of where you navigate. Crucially, Stripe **disables or greys-out live-only settings while in a test sandbox** and shows an inline notice, so the environment itself constrains what you can do rather than trusting the user to be careful. The mode is fundamentally keyed to the API key, not just a view filter — the toggle is a *view over* the real scope boundary. ([TemperStack](https://www.temperstack.com/learn/stripe/switch-test-live-mode/), [Stably](https://www.stably.ai/blog/mastering-stripes-test-mode))

**Vercel (team / project).** Two-level scope: a **team switcher** in the top-left, then a **project** chosen within it. A **Command Menu (⌘K)** offers keyboard-driven scope jumps. The CLI mirrors this exactly — `vercel switch` changes persistent scope, while a per-command `--scope`/`--team (-T)` flag overrides scope for *one* command without changing the default. That "sticky default + per-action override" split is the key pattern. ([vercel switch](https://vercel.com/docs/cli/switch), [Global Options](https://vercel.com/docs/cli/global-options))

**Linear (workspace).** The genuinely instructive part is **settings layering**: workspace admins set **workspace defaults** (templates, display options), and any member can **layer personal preferences on top** — "Set as default" saves a workspace default, but individuals always retain personal overrides. Settings UI is **split by authority**: members see settings about *their own work*; admins/owners additionally see workspace-administration settings. ([Workspaces](https://linear.app/docs/workspaces), [Display options](https://linear.app/docs/display-options), [Members & roles](https://linear.app/docs/members-roles))

**Google Cloud (project).** Persistent **project picker** in the top bar. Anti-mistake mechanism: **environment tags** (prod/staging/dev) render a **visual indicator in the picker** warning that changes affect production. CLI guidance is explicit and transferable: **show the active config in your prompt**, and in scripts **never rely on the ambient default — always pass `--project`/`--configuration`**. ([creating-managing-projects](https://cloud.google.com/resource-manager/docs/creating-managing-projects), [gcloud configs](https://oneuptime.com/blog/post/2026-02-17-how-to-switch-between-multiple-gcp-projects-using-gcloud-config-configurations/view))

**AWS (account).** Launched Aug 2025: **admin-assignable per-account color** rendered as the **console top border + account tab**, precisely to stop "one wrong click in the wrong account." Convention: green=dev, yellow=test, red=prod. Notably it's a **governed** signal (IAM `uxc:PutAccountColor`), so the color is trustworthy, not a personal browser hack; it **reverts to gray** if a switched-into role lacks the permission — i.e., fail to a neutral state rather than a misleading one. ([AWS What's New](https://aws.amazon.com/about-aws/whats-new/2025/08/aws-management-console-assigning-color-aws-account/), [AWS Builder Center](https://builder.aws.com/content/363UaxSjaqokF72afmixTzRi53Z/aws-account-color-a-small-feature-that-makes-a-big-difference))

**Notion (workspace).** Switcher is the **clickable current-workspace name, top-left of the sidebar**; from it you switch, create, join, **add another account**, and reach settings. The sidebar reinforces scope structurally with **Teamspaces (shared) vs Private (only-you)** sections — the same tree visibly separates shared-scope from personal-scope items. ([Create/switch workspaces](https://www.notion.com/help/create-delete-and-switch-workspaces), [Navigate the sidebar](https://www.notion.com/help/navigate-with-the-sidebar))

**GitHub (org / repo).** *(Expert knowledge — not re-searched.)* Scope is **path-encoded** (`/org/repo`) and shown as a breadcrumb, so the URL *is* the scope indicator and is shareable/bookmarkable. Settings are layered: **org-level policies** (member permissions, default branch protection) cascade as defaults that **repos inherit and can tighten**, not loosen. The context switcher is the account/org avatar menu top-left.

## Takeaways for your app (connected-account scope + user-global scope + reusable presets)

1. **Put the scope switcher top-left and make it persistent + global.** Every one of these products anchors it in the same corner and keeps it visible on every screen (Stripe, Vercel, Notion, GCP, AWS). Your connected-account selector should live there and never scroll away — the user must be able to answer "which account am I acting on?" at any moment without navigating.

2. **Signal scope with color/an ambient chrome cue, not just a label — and reserve the loudest color for the highest-consequence scope.** AWS's top-border color and Stripe's orange/blue exist specifically because text labels get tuned out. Give each connected account a persistent color/badge in the header (and echo it near destructive/live-trade actions). Given your CLAUDE.md rule that **paper mode is the default and real trades are high-stakes**, treat live/real-money account scope like AWS "prod red": a distinct, hard-to-miss chrome state. ([AWS](https://aws.amazon.com/about-aws/whats-new/2025/08/aws-management-console-assigning-color-aws-account/), [Stripe/TemperStack](https://www.temperstack.com/learn/stripe/switch-test-live-mode/))

3. **Make the environment enforce the boundary, don't just display it.** Stripe **disables live-only settings inside a test sandbox**. Mirror this: when a user is scoped to a paper/test account, structurally grey-out or gate real-order controls, and vice-versa — so wrong-scope actions are *impossible in that view*, not merely discouraged. ([Stripe/Stably](https://www.stably.ai/blog/mastering-stripes-test-mode))

4. **Separate "sticky scope" from "per-action scope override."** Vercel's `switch` (persistent) vs `--scope`/`-T` (one command) is the model. Let users set a default working account but allow a single proposal/order to target a different account inline **with an explicit confirmation** — and for any automated/scripted path, follow GCP's rule: **never inherit the ambient scope; require the account to be named explicitly.** ([Vercel](https://vercel.com/docs/cli/global-options), [GCP configs](https://oneuptime.com/blog/post/2026-02-17-how-to-switch-between-multiple-gcp-projects-using-gcloud-config-configurations/view))

5. **Layer settings as account-default → user-override, and label each setting's origin.** This is Linear's core pattern: workspace/admin sets defaults, users layer personal preferences on top, always resolvable. Map it to your three tiers: **connected-account-scoped config** (policy/risk limits that belong to the account) forms the floor; **user-global preferences** (display, notifications) sit above; and each control should show *where its value comes from* ("inherited from account" vs "your override"). ([Linear display options](https://linear.app/docs/display-options))

6. **Make "reusable presets" first-class, portable objects that carry their scope.** Notion's Teamspaces-vs-Private split and Linear's "Set as default" show the right mental model: a preset should be explicitly **user-global (reusable across all your accounts)** or **account-pinned**, and its badge should say which. When applying a global preset into a specific account, surface a diff/confirm step so a broad preset can't silently overwrite account-specific safety limits. ([Notion sidebar](https://www.notion.com/help/navigate-with-the-sidebar), [Linear](https://linear.app/docs/display-options))

7. **Encode scope in the URL/route so it's shareable, bookmarkable, and unambiguous.** GitHub's `/org/repo` and GCP's project-in-URL mean a link *is* a scope. Namespacing your routes by account id (e.g. `/accounts/:id/...`) makes deep links land in the right scope, prevents a stale tab from acting on the wrong account, and makes "which scope" answerable from the address bar alone. *(GitHub structure: expert knowledge.)*

8. **Split the settings surface by authority, and fail scope signals to a safe/neutral state.** Linear shows members only their-own-work settings while admins see administration; AWS's color **reverts to gray when permissions are absent** rather than showing a stale/misleading color. Combine both: gate account-level risk/policy settings behind the appropriate role, and if account context is unknown/unresolved, render a **neutral "no account selected"** state that blocks scoped actions rather than defaulting to the last (possibly live) account. ([Linear members](https://linear.app/docs/members-roles), [AWS Builder Center](https://builder.aws.com/content/363UaxSjaqokF72afmixTzRi53Z/aws-account-color-a-small-feature-that-makes-a-big-difference))

## Sources
- Stripe: [TemperStack](https://www.temperstack.com/learn/stripe/switch-test-live-mode/), [Stably](https://www.stably.ai/blog/mastering-stripes-test-mode)
- Vercel: [vercel switch](https://vercel.com/docs/cli/switch), [CLI Global Options](https://vercel.com/docs/cli/global-options)
- Linear: [Workspaces](https://linear.app/docs/workspaces), [Display options](https://linear.app/docs/display-options), [Members & roles](https://linear.app/docs/members-roles)
- Google Cloud: [Creating/managing projects](https://cloud.google.com/resource-manager/docs/creating-managing-projects), [gcloud config configurations](https://oneuptime.com/blog/post/2026-02-17-how-to-switch-between-multiple-gcp-projects-using-gcloud-config-configurations/view)
- AWS: [What's New: account color](https://aws.amazon.com/about-aws/whats-new/2025/08/aws-management-console-assigning-color-aws-account/), [AWS Builder Center](https://builder.aws.com/content/363UaxSjaqokF72afmixTzRi53Z/aws-account-color-a-small-feature-that-makes-a-big-difference)
- Notion: [Create/switch workspaces](https://www.notion.com/help/create-delete-and-switch-workspaces), [Navigate the sidebar](https://www.notion.com/help/navigate-with-the-sidebar)
- GitHub: expert knowledge (org/repo path-encoded scope, org→repo policy inheritance), not re-verified via search.

### research:settings-taxonomy
That page returned only the title (JS-rendered), but the earlier search results already surfaced the substantive HIG guidance. I have enough to synthesize the brief.

---

# Settings / Preferences Information Architecture — Patterns Brief

Sourced from Nielsen Norman Group, Apple HIG, Android/Material, and the settings structures of Slack, Notion, Stripe, and GitHub. Where a claim rests on synthesis rather than a specific cited page, it is marked *(expert synthesis)*.

## 1. How to group a large settings surface

**Start from IA, not from the existing screens.** Run a card sort / tree test to discover how *users* cluster the options, then label categories so they are "descriptive, specific, and mutually exclusive" — a user should never hesitate about which bucket a setting lives in. Ambiguous or overlapping labels are the #1 findability failure NN/g flags for information architecture. ([NN/g IA](https://www.nngroup.com/topic/information-architecture/), [NN/g Intranet IA report](https://www.nngroup.com/reports/intranet-information-architecture-navigation/))

**Keep top-level categories few and generic.** The consistently recommended range is ~4–7 top-level groups, with canonical labels like *General, Account, Notifications, Appearance, Privacy, Security, Help/About*. Fewer, generic buckets scale better than many specific ones, because new settings have an obvious home. ([Toptal settings UX](https://www.toptal.com/designers/ux/settings-ux), [Setproduct](https://www.setproduct.com/blog/settings-ui-design))

**Use a consistent three-part structure:** section header → grouped related items (with visual dividers) → sub-screen when a group gets large. Android formalizes exactly this ladder: `PreferenceCategory` (grouped items with a title on one screen) → nested `PreferenceFragment` sub-screens "when you have a large number of Preference objects" or "distinct categories that benefit from separate screens." iOS Settings' success is attributed to the same clear parent-child, grouped-list structure. ([Android: organize your settings](https://developer.android.com/develop/ui/views/components/settings/organize-your-settings), [Apple HIG Settings](https://developer.apple.com/design/human-interface-guidelines/patterns/settings/))

**Prioritize within and across groups by real usage data.** Push the most-used category and the most-used items to the top; don't order alphabetically or by internal team ownership. ([Toptal settings UX](https://www.toptal.com/designers/ux/settings-ux))

## 2. When to use tiers / scopes

A "scope" is *whose* setting this is; a "tier" is *how deep/advanced* it is. Treat them as two different axes.

**Scope (personal vs shared/admin) — the dominant pattern in every B2B product studied:**
- **GitHub** separates *personal account* settings, *organization* settings, and *repository* settings into distinct settings homes with their own permission model. ([GitHub account types](https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts))
- **Slack** splits *your preferences* (personal, single member) from *workspace* settings from *org/Enterprise* settings; org policies can **lock** a workspace setting, shown with a lock icon. ([Slack workspace admin](https://slack.com/help/categories/200122103-Workspace-administration), [Slack org vs workspace](https://trailhead.salesforce.com/content/learn/modules/org-and-workspace-settings-in-slack-quick-look/learn-about-policies-and-settings-in-slack))
- **Notion** puts personal (*My settings*) and *workspace* settings inside the product, but pulls *organization-level* controls into a separate admin console "that lives outside the main product." ([Notion workspace settings](https://www.notion.com/help/workspace-settings), [Notion org management](https://www.notion.com/help/guides/everything-about-setting-up-and-managing-an-organization-in-notion))
- **Stripe** buckets its Dashboard settings into exactly three scopes: **Personal, Account, and Product**, with organization roles layered above account roles. ([Stripe dashboard basics](https://docs.stripe.com/dashboard/basics), [Stripe orgs](https://docs.stripe.com/get-started/account/orgs))

**Rules that fall out of these:** make the current scope unmistakable (label + visual home); never mix scopes on one screen; when a higher scope constrains a lower one, show it inline (Slack's lock icon) rather than silently hiding it. *(expert synthesis)*

**Tier (basic vs advanced) — governed by progressive disclosure:** defer advanced/rarely-used options to a secondary surface, showing only primary options by default. This improves 3 of the 5 usability components — learnability, efficiency, and error rate — and helps *both* novices (fewer mistakes) and experts (less to scan past). ([NN/g Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/))

**Hard limit: stop at two disclosure levels.** NN/g: designs beyond two levels "typically have low usability because users get lost between levels" — if you need three, simplify or regroup instead. So *scope* + *one basic/advanced split* is about all the depth you can afford before findability degrades. ([NN/g Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/))

## 3. Novice-safe defaults with power-user depth

- **Ship sensible, safe defaults so most users never open settings at all** — Apple's first settings principle is to minimize configuration and choose defaults that work for the majority. ([Apple HIG Settings](https://developer.apple.com/design/human-interface-guidelines/patterns/settings/))
- **Put frequently-changed controls in-context, not in the settings screen.** Apple explicitly reserves the settings surface for infrequent, advanced configuration; anything toggled often belongs where the user already is. ([Apple HIG Settings](https://developer.apple.com/design/human-interface-guidelines/patterns/settings/))
- **Decide what's "primary" from evidence, not opinion** — task analysis, field studies, and frequency-of-use stats; for existing systems, observe whether a setting is used deliberately or reached by mistake. ([NN/g Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/))
- **Two non-negotiables when you hide advanced options:** (1) everything frequently needed must be up front so users only *rarely* go deeper; (2) the path to advanced options must be obvious and clearly labeled about what's behind it. ([NN/g Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/))

## 4. Search & deep-linking

- **Add search once the surface is large** — grouping helps, but "including a search will make it 5x better"; it's the escape hatch when a user's mental model doesn't match your categories, and it directly mitigates the risk of mis-grouping. iOS's settings search is the canonical example. ([Toptal settings UX](https://www.toptal.com/designers/ux/settings-ux), [Setproduct](https://www.setproduct.com/blog/settings-ui-design))
- **Make individual settings deep-linkable** so support docs, empty states, and error messages can jump the user straight to the right pane. Apple's platform lesson: provide an explicit *button/shortcut into the relevant settings location* rather than relying on fragile URL paths — Apple notes deep URL-scheme access to specific sub-screens "is not supported API and may break." Design your own settings so each pane has a stable, linkable route. ([Apple HIG Settings](https://developer.apple.com/design/human-interface-guidelines/patterns/settings/), [search result: Settings Launch URL guidance](https://developers.apple.com/design/human-interface-guidelines/patterns/settings/))
- **Keep hierarchy shallow so both search results and deep links stay comprehensible** — this reinforces the two-level cap; a deep link that drops the user four levels down with no wayfinding is disorienting. ([NN/g Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)) Pair deep links with breadcrumbs / current-location highlighting, which NN/g calls standard wayfinding. ([NN/g Intranet IA](https://www.nngroup.com/reports/intranet-information-architecture-navigation/))

## 5. Six-to-eight takeaways for consolidating 9 scattered sections across 2 scopes

1. **Split by scope first, at the top level.** Your 2 scopes (e.g. *Personal* vs *Workspace/Org*) become the primary division — mirroring Stripe's Personal/Account/Product and Slack/GitHub/Notion. Give each scope its own clearly labeled home; never interleave them on one screen. ([Stripe](https://docs.stripe.com/dashboard/basics), [Slack](https://trailhead.salesforce.com/content/learn/modules/org-and-workspace-settings-in-slack-quick-look/learn-about-policies-and-settings-in-slack))
2. **Collapse 9 sections into ~4–6 generic, mutually-exclusive categories per scope.** Nine flat sections is above the comfortable top-level count; card-sort them into canonical buckets (General, Account, Notifications, Privacy/Security, Appearance, About) so every setting has one obvious home. ([Toptal](https://www.toptal.com/designers/ux/settings-ux), [NN/g IA](https://www.nngroup.com/reports/intranet-information-architecture-navigation/))
3. **Cap depth at two levels.** Category → grouped items, with a sub-screen only for genuinely large groups. Don't create scope → category → subcategory → advanced chains. ([NN/g Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [Android](https://developer.android.com/develop/ui/views/components/settings/organize-your-settings))
4. **Apply progressive disclosure per group:** primary options visible, advanced ones behind a clearly labeled "Advanced" reveal — one extra level, no more. Choose the primary set from usage data, not team boundaries. ([NN/g Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/))
5. **Set safe defaults and pull hot settings in-context.** If a control is toggled often, surface it where the work happens and leave the settings surface for infrequent configuration — this shrinks the consolidated surface itself. ([Apple HIG Settings](https://developer.apple.com/design/human-interface-guidelines/patterns/settings/))
6. **Ship settings search from day one of the consolidation.** It's the insurance policy against any remaining mis-grouping across the 9→N migration and lets users bypass the scope decision entirely. ([Toptal](https://www.toptal.com/designers/ux/settings-ux))
7. **Make every pane deep-linkable and preserve old routes.** Redirect the 9 old section URLs to their new homes; expose stable per-setting links for docs/empty-states/errors so the reorg doesn't break inbound links. ([Apple HIG Settings](https://developer.apple.com/design/human-interface-guidelines/patterns/settings/)) *(expert synthesis on migration/redirects)*
8. **Show cross-scope constraints inline.** When a workspace/org setting overrides or locks a personal one, indicate it in place (Slack's lock icon) instead of hiding it — so the 2-scope model stays legible rather than confusing. ([Slack org vs workspace](https://trailhead.salesforce.com/content/learn/modules/org-and-workspace-settings-in-slack-quick-look/learn-about-policies-and-settings-in-slack))

---

### Sources
- [NN/g — Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
- [NN/g — Information Architecture (topic hub)](https://www.nngroup.com/topic/information-architecture/)
- [NN/g — Intranet IA, Navigation & Menus report](https://www.nngroup.com/reports/intranet-information-architecture-navigation/)
- [Apple HIG — Settings pattern](https://developer.apple.com/design/human-interface-guidelines/patterns/settings/)
- [Android Developers — Organize your settings](https://developer.android.com/develop/ui/views/components/settings/organize-your-settings)
- [Material Design — Settings pattern](https://m1.material.io/patterns/settings.html)
- [Slack — Org vs workspace settings (Trailhead)](https://trailhead.salesforce.com/content/learn/modules/org-and-workspace-settings-in-slack-quick-look/learn-about-policies-and-settings-in-slack); [Slack — Workspace administration](https://slack.com/help/categories/200122103-Workspace-administration)
- [Notion — Workspace settings](https://www.notion.com/help/workspace-settings); [Notion — Managing an organization](https://www.notion.com/help/guides/everything-about-setting-up-and-managing-an-organization-in-notion)
- [Stripe — Web Dashboard basics](https://docs.stripe.com/dashboard/basics); [Stripe — Organizations](https://docs.stripe.com/get-started/account/orgs)
- [GitHub — Types of GitHub accounts](https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts)
- [Toptal — How to Improve App Settings UX](https://www.toptal.com/designers/ux/settings-ux); [Setproduct — Settings UI design](https://www.setproduct.com/blog/settings-ui-design)

Note: The Apple HIG Settings page is JS-rendered and returned only its title on direct fetch; its guidance above is drawn from Apple's indexed search excerpts plus the HIG mirror, and is consistent across both. The GitHub/Slack/Notion/Stripe structure claims come from their own docs/help centers as cited.

### research:onboarding-modes
I have enough across all four angles (mode-safety, paper→live ramping, first-run/progressive disclosure, autonomy gating). Here is the brief.

---

# Patterns Brief: First-Run Flow + Progressive-Risk / Environment-Mode Design for a Trading Tool

Scope: onboarding a user from simulation into real money, safely presenting Test(sim) → Paper → Real-money modes, and ramping propose-only → auto-execute authority. All takeaways are cited; where I lean on synthesis rather than a single source, I say so.

## How the reference apps actually do it

- **Stripe (test vs live money):** Test and live are *fully separate data planes* keyed by the credential itself (`sk_test_…`/`pk_test_…` vs `sk_live_…`), not by a UI toggle — the toggle only changes which key the dashboard uses. Objects never cross the boundary, and every API response carries a `livemode` boolean so records are self-labeling. Dashboard pages show a persistent test-data banner and disable/annotate settings that would leak into live. [Stripe: API keys](https://docs.stripe.com/keys), [Stripe: handling modes](https://docs.stripe.com/stripe-apps/handling-modes)
- **Alpaca (paper → live brokerage):** Paper and live are *identical API surfaces* with different base URLs + keys, so a strategy proven in paper runs unchanged live by swapping credentials. Crucially, moving to real money is **not a toggle** — it gates on a real regulatory onboarding (KYC/broker-dealer account with Alpaca Securities LLC) that simply doesn't exist in paper. [Alpaca: paper trading](https://docs.alpaca.markets/us/docs/paper-trading), [Alpaca: start paper trading](https://alpaca.markets/learn/start-paper-trading)
- **Regulated onboarding (Wise/Revolut/Chime):** separate the *regulated minimum* (KYC) from optional setup, explicitly label mandatory vs optional, show per-step time estimates, and allow save-and-resume; product is revealed only after the regulated minimum clears. [Eleken](https://www.eleken.co/blog-posts/fintech-onboarding-simplification), [Appcues](https://www.appcues.com/blog/fintech-onboarding-examples)

## Takeaways for the FIRST-RUN flow

1. **Progressive disclosure, gated by risk not by feature count.** Show only what's needed at each step and reveal complexity as the user advances; defer profile/optional setup until *after* they've touched the core product in sim. This is the dominant fintech-onboarding pattern and it maps cleanly onto a Test→Paper→Real ladder — each rung unlocks the next. [Userpilot](https://userpilot.com/blog/progressive-disclosure-examples/), [UXPin](https://www.uxpin.com/studio/blog/what-is-progressive-disclosure/), [Eleken](https://www.eleken.co/blog-posts/fintech-onboarding-simplification)

2. **Let the user *do the core thing* in sim before any account/funding friction.** Wise/Revolut/Chime defer the heavy steps and let users experience value first; regulated first-session completion is only ~40–60%, so front-loading KYC/funding kills activation. Start every user in Test(sim) with a working scan/propose loop, then introduce funding as a later, explained step. [Appcues](https://www.appcues.com/blog/fintech-onboarding-examples), [CleverTap](https://clevertap.com/blog/onboarding-fintech-app-users/)

3. **Explain *why* at each gate, inline, with time estimates and save/resume.** Don't drop a blank funding/KYC screen — annotate it ("we verify ID to comply with regulations and protect your account"), show estimated time, and allow resume. This converts perceived risk into trust. [Eleken](https://www.eleken.co/blog-posts/fintech-onboarding-simplification), [Verified.inc](https://verified.inc/post/best-user-onboarding-practices-and-ux-design-in-finance)

4. **Onboarding is perception-management: reinforce safety with tangible cues.** Surface biometric/2FA setup and "your money is untouched in this mode" messaging early — in a trading tool the analog is a permanent mode badge + "no real orders can be placed here." [CleverTap](https://clevertap.com/blog/onboarding-fintech-app-users/), [Verified.inc](https://verified.inc/post/best-user-onboarding-practices-and-ux-design-in-finance)

## Takeaways for presenting Test(sim) → Paper → Real-money SAFELY

5. **Make the mode a property of the *credential/data plane*, not a soft UI switch (the Stripe/Alpaca lesson).** Real-money capability should be a different key/endpoint that literally cannot act until real onboarding completes — so a mis-click can't route a sim action to real money. Keep the three data sets strictly separated and never let objects cross. [Stripe: keys](https://docs.stripe.com/keys), [Alpaca: paper trading](https://docs.alpaca.markets/us/docs/paper-trading)

6. **Self-label every record with its mode, and show a persistent, unmissable mode banner.** Stripe's `livemode` field + test banner is the pattern: store the environment on every order/fill/P&L row and render a global "TEST" / "PAPER" / "LIVE — REAL MONEY" indicator so a user (or a reviewer reading logs) can never confuse which world a number came from. This aligns with your repo's own rule against ever labeling real data "mock" and vice-versa. [Stripe: handling modes](https://docs.stripe.com/stripe-apps/handling-modes), [Stripe: keys](https://docs.stripe.com/keys)

7. **Gate the Real-money rung behind a real one-way-door ritual, not a checkbox — use type-to-confirm friction.** Reversibility/complexity/frequency determine how much friction an action deserves; irreversible/catastrophic actions (arming real money, raising a real-money limit) warrant a "speed bump" — GitHub/AWS-style *type-to-confirm* (e.g. type the account name or the dollar limit), an explicit "REAL MONEY" restatement, and a summary of exactly what's being enabled. Reserve this heavy friction for the genuinely dangerous transitions only. [Smashing Magazine](https://www.smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces/), [Medium: destructive-actions UX guide](https://medium.com/design-bootcamp/a-ux-guide-to-destructive-actions-their-use-cases-and-best-practices-f1d8a9478d03), [Haneke: intentional friction](https://www.hanekedesign.com/unlocking-the-power-of-intentional-friction-how-ui-ux-design-shapes-user-actions/)

## Takeaways for propose-only → auto-execute AUTHORITY

8. **Treat propose-only vs auto-execute as HITL vs HOTL, and default to HITL.** Propose-only = *human-in-the-loop*: a blocking gate, nothing executes until explicitly approved. Auto-execute = *human-on-the-loop*: the system acts within preset bounds while the human supervises via dashboard + kill switch. Ship HITL first; earn HOTL. [Medium: HITL spectrum](https://medium.com/@tahirbalarabe2/what-is-human-in-the-loop-the-spectrum-of-human-ai-interaction-0f762426a094), [OpenAI: guardrails & approvals](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)

9. **Any auto-execute grant must come bundled with preset limits + an always-available kill switch, and apply autonomy selectively.** The regulated pattern (SEC-requested kill switches; RBI's proposed mandatory kill switch + human-in-the-loop for bank AI) is: automated cut-offs on per-order/daily-notional/risk thresholds, a single "halt everything" control anyone can hit, and HITL reserved for high-stakes decisions rather than every step (over-gating creates bottlenecks *and* alert fatigue). Note the practitioner caveat — an auto kill-switch firing at the wrong moment can itself destabilize — so pair it with a clear manual halt. This dovetails with your codebase's existing paper-mode default and daily-notional tracking. [OpenAI: guardrails](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals), [NYIF: trading kill switch](https://www.nyif.com/articles/trading-system-kill-switch-panacea-or-pandoras-box), [ThePrint: RBI kill switch](https://theprint.in/tech/a-human-firmly-in-the-loop-rbi-proposes-kill-switch-for-ai-used-by-banks-nbfcs/2970201/)

## Synthesis: the recommended ladder (my design opinion, grounded in the above)

Two **orthogonal** axes — don't collapse them into one slider:

- **Money-reality axis:** Test(sim) → Paper → Real. Each rung is a *separate data plane / credential*, self-labeled, with a persistent banner. Real is gated by genuine onboarding (KYC/funding) + type-to-confirm arming.
- **Authority axis:** propose-only (HITL) → auto-execute (HOTL), each with its own preset limits + kill switch.

Enforce the ordering that **you cannot arm auto-execute on Real money until you've demonstrated it on Paper**, and every rung-up on either axis explains *why*, shows what changes, and (for the two dangerous ones — enabling Real, enabling auto-execute-on-Real) demands type-to-confirm friction. This is exactly Alpaca's "prove it in paper, then swap credentials" discipline plus Stripe's hard data-plane separation, layered with HITL-before-HOTL autonomy.

Sources:
- [Stripe: API keys](https://docs.stripe.com/keys)
- [Stripe: handling modes](https://docs.stripe.com/stripe-apps/handling-modes)
- [Alpaca: paper trading docs](https://docs.alpaca.markets/us/docs/paper-trading)
- [Alpaca: start paper trading](https://alpaca.markets/learn/start-paper-trading)
- [Eleken: fintech onboarding UX](https://www.eleken.co/blog-posts/fintech-onboarding-simplification)
- [Appcues: fintech onboarding examples](https://www.appcues.com/blog/fintech-onboarding-examples)
- [CleverTap: onboarding fintech users](https://clevertap.com/blog/onboarding-fintech-app-users/)
- [Userpilot: progressive disclosure](https://userpilot.com/blog/progressive-disclosure-examples/)
- [UXPin: progressive disclosure](https://www.uxpin.com/studio/blog/what-is-progressive-disclosure/)
- [Verified.inc: onboarding UX in finance](https://verified.inc/post/best-user-onboarding-practices-and-ux-design-in-finance)
- [Smashing Magazine: managing dangerous actions](https://www.smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces/)
- [Medium: destructive-actions UX guide](https://medium.com/design-bootcamp/a-ux-guide-to-destructive-actions-their-use-cases-and-best-practices-f1d8a9478d03)
- [Haneke: intentional friction](https://www.hanekedesign.com/unlocking-the-power-of-intentional-friction-how-ui-ux-design-shapes-user-actions/)
- [Medium: HITL spectrum](https://medium.com/@tahirbalarabe2/what-is-human-in-the-loop-the-spectrum-of-human-ai-interaction-0f762426a094)
- [OpenAI: guardrails & human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
- [NYIF: trading system kill switch](https://www.nyif.com/articles/trading-system-kill-switch-panacea-or-pandoras-box)
- [ThePrint: RBI kill switch / human-in-the-loop](https://theprint.in/tech/a-human-firmly-in-the-loop-rbi-proposes-kill-switch-for-ai-used-by-banks-nbfcs/2970201/)
