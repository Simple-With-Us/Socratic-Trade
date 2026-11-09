# Go-to-Market: awareness, SEO, advertising, compliance

Living doc. Captures the launch-prep research (deep-research run, 2026-06-22), the
decisions taken, and a checklist of what is **done / partial / deferred**. This is
preparation only — the owner may or may not make the app public. Defaults are chosen
so nothing leaks publicly until explicitly enabled.

> Not legal advice. The RIA-status determination and SEC Marketing-Rule applicability
> require qualified securities counsel before any live-trading marketing.

## The core decision (positioning)

The product can run **paper (simulated)** and **live (real-money)** modes. For all
*public-facing* marketing we **lead with research / analytics / paper-trading /
education** and keep live execution present-but-not-the-headline. This single choice:

- **Widens ad eligibility** — the "AI that trades your money" framing is what trips the
  ad bans; an education/software framing does not.
- **Lowers regulatory risk** — leading with recommendations/performance is what pulls the
  full SEC Marketing Rule (and possibly RIA registration) onto the marketing.
- **Unlocks the best awareness channels** (Reddit self-serve, Show HN, AI directories)
  which gate or reject trading-platform promotion but allow software/education.

App-state caveat: auth was only recently hardened. Do **not** open real-money signups
yet — the first public motion (if any) should be a **waitlist / paper-mode beta**.

## What gates paid ads (verified 2026-06-22)

| Platform | Will it run an AI *live-trading* ad? | Source |
|---|---|---|
| Google Search | Likely yes for **plain US equities** — the "complex speculative products" gate names CFDs/spread-betting/rolling-spot-forex, not stock-trading software; US is not on Google's financial-verification country list. Keep copy to equities (forex/CFD/"signals" trips the gate). | [Google 15188218](https://support.google.com/adspolicy/answer/15188218?hl=en), [12390454](https://support.google.com/adspolicy/answer/12390454?hl=en) |
| Reddit (self-serve) | **No** as a trading platform (Sales-rep gate, no self-serve); **yes** if framed as "personal finance software / educational resources" (explicitly exempt). | [Reddit policy](https://business.reddithelp.com/s/article/financial-cryptocurrency-products-and-services-policy) |
| TikTok | **Effectively closed** — bans "single securities trading" (US), "complex speculative investments", and universally bans "get-rich-quick"/"too-good-to-be-true". | [TikTok policy](https://ads.tiktok.com/help/article/tiktok-ads-policy-financial-services) |
| Meta (FB/IG), X, Microsoft/Bing | **Not yet verified** — each has financial-products policies; verify directly before any spend. | (open) |

**Budget reality:** Finance/Insurance averages ~$3.46 CPC, ~2.5% conversion, ~$84
cost-per-lead, so a $100–500 budget buys ≈ 1–6 leads. Paid is a *measurement test*, not
the first-month engine. If spending at all: one tight Google Search campaign on
non-speculative equity/SaaS keywords, hard-capped.

## SEO plan

- **Keyword themes (commercial-investigation intent first):** "best AI trading bot",
  "automated trading software", "[competitor] alternative", "paper trading simulator",
  "AI stock analysis tool". Chase comparison/long-tail before head terms.
- **Binding constraint — YMYL + E-E-A-T:** finance is "Your Money or Your Life", held to
  the strictest Experience/Expertise/Authoritativeness/Trust bar. A new domain ranks
  **slowly (3–9+ months)**. Counter with named authorship + credentials, methodology/about
  pages, citations, transparent disclaimers, and third-party mentions.
- **Technical (Next.js 15):** server-render marketing pages (SSG/ISR), clean metadata
  (title/description/canonical/OG/Twitter), `robots.txt` + `sitemap.xml`, JSON-LD, green
  Core Web Vitals. (Foundation shipped — see checklist.)

## Awareness channels (ranked, lead with the tryable/education framing)

1. **Hacker News "Show HN"** — needs a *tryable* product (no landing/signup pages; never
   ask for upvotes). High yield if there's a real demo. [rules](https://news.ycombinator.com/showhn.html)
2. **AI-tool directories** (There's An AI For That, Futurepedia, etc.) — free listings +
   backlinks; need a live tool.
3. **Subreddits** (r/algotrading, r/Daytrading, r/stocks, r/investing) — high fit, but most
   ban direct self-promo; participate value-first per each sub's rules (ban risk for links).
4. **Product Hunt** — one-day spike + backlink.
5. **X/"fintwit"** — organic build; paid shout-outs become regulated endorsements (below).
6. **Niche newsletters / YouTube** — targeted but paid = endorsement (disclosure rules).

## Compliance (the real binding constraint)

- **RIA trigger:** if the agent *recommends* trades for compensation, assess Investment
  Advisers Act §202(a)(11) / §203 registration. This is the pivot — get counsel.
  [SEC guide](https://www.sec.gov/resources-small-businesses/small-business-compliance-guides/investment-adviser-marketing)
- **If RIA → SEC Marketing Rule 206(4)-1** governs ads + landing pages: "advertisement"
  is broad and sweeps in **compensated testimonials/endorsements** (influencers,
  affiliates, referral/refer-a-friend, customer testimonials). Disclosures must be clear
  & prominent **within** the ad (hyperlinks don't count; not smaller/lighter font);
  written agreement if comp > $1,000/12mo. The Dec-16-2025 SEC risk alert flagged exactly
  these. [risk alert](https://www.sec.gov/files/exams-riskalert-mrkt-rule-2512-508.pdf),
  [PR 2020-334](https://www.sec.gov/newsroom/press-releases/2020-334)
- **Performance claims gated:** no gross without net at equal prominence; standardized
  time periods; no implying SEC approval; benefits always paired with risks. Bars the
  classic "X% returns" hero claim.
- **FTC is the always-on floor:** Section 5 deception/unfairness applies to fintech
  "regardless of innovation." [FTC](https://www.ftc.gov/business-guidance/credit-finance/fintech)
- **Disclaimers used on the landing page** (and required on any future marketing): not
  investment advice; not a broker-dealer / RIA; substantial risk of loss; simulated
  performance ≠ future results; nothing is a recommendation; consult a licensed pro.

## First-30-days playbook (if/when going public)

- **Highest-ROI first action:** a free, *tryable*, compliantly-disclaimed demo — it
  unlocks Show HN + directories and de-risks the ad/regulatory constraints. (Deferred —
  see "Public demo" below.)
- Week 1 — landing page live (flag on) + SEO foundation + directory submissions.
- Week 2 — Show HN of the demo + value-first community participation.
- Week 3 — one narrow high-intent Google Search test ($100–500 capped) + first SEO content.
- Week 4 — measure, double down on the one channel that produced signups; no
  influencer/affiliate/testimonial tactic until SEC in-ad disclosures are in place.

## Status checklist

**Done (this session):**
- ✅ SEO foundation, **noindex by default**: full `metadata` (title/description/keywords/
  canonical/OpenGraph/Twitter, env-gated robots) in `app/layout.tsx`; `app/robots.ts`
  (disallow-all until `NEXT_PUBLIC_ALLOW_INDEXING=true`); `app/sitemap.ts`.
- ✅ Compliant, education-led **landing page** at `app/welcome/page.tsx`, **flag-gated**
  (`LANDING_PAGE_ENABLED`, default off → 404), with prominent disclosures + JSON-LD;
  `/welcome` added to middleware `PUBLIC_PREFIXES`; env documented in `.env.example`.
- ✅ **Wording corrected**: the landing describes paper trading as **via a third-party
  connection (e.g. Alpaca Paper Trading)**, and explicitly notes the built-in local
  simulator ("Test — Local Sim") is less realistic than a connected paper account.
- ✅ **Strategy overview page** at `app/strategy/page.tsx` (same flag-gate + noindex),
  derived honestly from `docs/strategic-framework.md` (six lenses, deterministic safety
  rules, learning loop, **honest limitations & risks**, practice modes). Linked from the
  landing hero + a dedicated section; `/strategy` added to `PUBLIC_PREFIXES`.
- ✅ **Button fix**: CTAs use a styled `<a>` via a new `buttonClass()` helper in
  `app/ui/primitives.tsx` (no more `<button>` nested in `<a>`).

**Partial / in progress:**
- 🟡 **Test account → funded local simulator** (decided; separate PR): the Test broker
  currently returns a $0 unfunded portfolio. Decision: make it a **funded local simulator**
  (simulated starting balance so it actually works), labeled "Test — Local Sim"
  (abbrev) / "Test — Local Simulator", and state in the app + docs that third-party paper
  (e.g. Alpaca) is **likely more realistic** than the local sim. Keeps the zero-config
  default; only one test references the current zeros, so breakage risk is low.
- 🟡 **A public no-signup demo** still needs an unauthenticated, sandboxed surface
  (separate, larger effort) — the funded local sim is for authed users, not yet a public demo.
- 🟡 **Positioning of the live feature** — leading with paper/education is implemented in
  copy; the live-trading marketing message still needs counsel (RIA determination).

**Deferred / owner action:**
- ⬜ **RIA / Marketing-Rule legal review** (securities counsel) — pivot for all live-trading marketing.
- ⬜ **Verify Meta / X / Microsoft-Bing** financial-ad policies before any spend there.
- ⬜ **SEO content** (comparison/"best AI for stock trading" posts with named authorship) — slow, multi-month.
- ⬜ **Go-public switches** when ready: set `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_ALLOW_INDEXING=true`, `LANDING_PAGE_ENABLED=true`; submit sitemap to Search Console; then run the 30-day playbook.

## How to flip it on (when ready)

1. Set `NEXT_PUBLIC_SITE_URL=https://socratictrade.com` (or the real domain).
2. Set `LANDING_PAGE_ENABLED=true` → `/welcome` becomes reachable.
3. Only when you truly want search visibility: `NEXT_PUBLIC_ALLOW_INDEXING=true` →
   robots allows `/welcome`, pages become indexable; submit the sitemap to Google Search Console.
4. Make `/welcome` the front door (optional) by linking it / redirecting unauthenticated `/` to it.

## Sources

Deep-research run 2026-06-22 (verified): Reddit, Hacker News, Google Ads, TikTok policies
+ SEC Marketing Rule / risk alert / FTC, linked inline above. Re-verify all platform
policies immediately before launch (they change frequently).
