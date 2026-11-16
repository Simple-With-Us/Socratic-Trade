/** Pure indicator definitions for the Macro board. Every tile carries a
 *  plain-language "what this is" line and, where the reading has a real,
 *  well-known threshold (inverted curve, VIX bands, credit spreads, …), a
 *  dynamic one-line interpretation of the CURRENT value. Missing data renders
 *  as "—" — never an estimate. When the FRED macro feed is unsourced
 *  (`macro.fredSourced === false`, incl. the VIX-only Yahoo fallback where
 *  asOf is still a real date), the backend substitutes placeholder constants
 *  for the FRED fields; this module deliberately blanks those tiles instead
 *  of showing fabricated numbers next to real ones. */

import type { DashboardSnapshot } from "../../dashboard-types";
import { EM_DASH } from "../lib/format";
import { regimeFromLabel } from "@/lib/market-regime";

export type Board = NonNullable<DashboardSnapshot["macroBoard"]>;
export type TileTone = "pos" | "neg" | "warn" | undefined;

export interface Tile {
  key: string;
  label: string;
  /** Display value; EM_DASH when the source didn't provide it. */
  value: string;
  tone?: TileTone;
  /** One line, plain language: what this indicator is and why it matters. */
  what: string;
  /** One line: what the CURRENT reading typically implies. Absent when the value is missing. */
  reading?: string;
  /** Data vintage for the tooltip (e.g. FRED date, CFTC report date). */
  asOf?: string;
}

export interface TileSection {
  id: string;
  title: string;
  /** Header tooltip: scope + sources for the whole group. */
  desc: string;
  tiles: Tile[];
}

/** What is actually sourced in this snapshot's macro payload. The backend has
 *  three paths (src/lib/macro.ts): full FRED fetch (everything real), the
 *  key-free "light macro" fallback (ONLY the VIX is a live Yahoo reading —
 *  every FRED field is a placeholder constant with asOf = today), and the
 *  fully-unavailable fallback (asOf === "unavailable", nothing real). */
export interface MacroSourcing {
  /** The FRED suite was fetched with a key — FRED fields and metrics derived from them are real. */
  fred: boolean;
  /** The VIX value is a live reading (full FRED fetch OR the key-free Yahoo fallback). */
  vix: boolean;
  /** The 3M/2Y/10Y Treasury yields (and the curves derived from them) are a live reading from the
   *  key-free Treasury.gov fallback — set even without a FRED key, mirroring how `vix` works. */
  treasury: boolean;
  /** CPI/unemployment (and nonfarmPayrollsChangeK, which has no FRED equivalent at all) are a live
   *  reading from the BLS fallback (keyless or lightly-keyed) — set even without a FRED key. */
  bls: boolean;
}

export function macroSourcing(board: Board): MacroSourcing {
  const anyLive = board.macro.asOf !== "unavailable";
  // `fredSourced`/`treasurySourced`/`blsSourced` ship with the same build as this UI; tolerate their
  // absence (older payload) by falling back to the legacy asOf heuristic for `fred` only. `treasury`/
  // `bls` default to false (not the asOf heuristic) since older payloads never set them — asOf being
  // live doesn't imply either keyless fallback actually ran.
  return {
    fred: board.macro.fredSourced ?? anyLive,
    vix: anyLive,
    treasury: board.macro.treasurySourced ?? false,
    bls: board.macro.blsSourced ?? false
  };
}

// ── Parsing / formatting ─────────────────────────────────────────────────────

/** Parse backend display strings ("4.20%", "$75.00", "220K", "20.8T") to a number. */
export function numFrom(s?: string): number | undefined {
  if (typeof s !== "string") return undefined;
  const n = parseFloat(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

const fmtSigned = (v: number | undefined, suffix = ""): string =>
  typeof v === "number" ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}${suffix}` : EM_DASH;

const fmtPlain = (v: number | undefined, digits = 2, suffix = ""): string =>
  typeof v === "number" ? `${v.toFixed(digits)}${suffix}` : EM_DASH;

const toneSign = (v?: number): TileTone => (typeof v === "number" ? (v >= 0 ? "pos" : "neg") : undefined);

// ── Sections ─────────────────────────────────────────────────────────────────

export function buildSections(board: Board, sourcing: MacroSourcing): TileSection[] {
  const { macro, derived, signals } = board;
  const mAsOf = sourcing.fred ? macro.asOf : undefined;

  // FRED values and metrics derived from them are blanked when the FRED feed is
  // unsourced — those strings would be placeholder constants. The VIX has its
  // own flag: the key-free Yahoo fallback makes it live even without FRED (but
  // vix3m and the term ratio stay FRED-gated — they'd mix real with placeholder).
  const mv = (s?: string): string => (sourcing.fred && s && s.length > 0 ? s : EM_DASH);
  const mn = (s?: string): number | undefined => (sourcing.fred ? numFrom(s) : undefined);
  const dn = (v?: number): number | undefined => (sourcing.fred ? v : undefined);

  // The 3M/2Y/10Y Treasury yields (and the two curves computed purely from them) have a SECOND,
  // key-free source (Treasury.gov) beside FRED — gate those specific tiles on either, so the
  // keyless fallback actually lights them up instead of showing EM_DASH next to real data.
  // `curvePolicy` (10Y − Fed funds) stays FRED-only below: Fed funds has no keyless source.
  const fredOrTreasury = sourcing.fred || sourcing.treasury;
  const mvRate = (s?: string): string => (fredOrTreasury && s && s.length > 0 ? s : EM_DASH);
  const dnRate = (v?: number): number | undefined => (fredOrTreasury ? v : undefined);
  const rateAsOf = fredOrTreasury ? macro.asOf : undefined;

  // CPI and unemployment ALSO have a second, key-free-capable source (BLS) beside FRED — gate
  // those two specific tiles (+ the misery index computed purely from them) on either, same
  // reasoning as the Treasury rate tiles above. nonfarmPayrollsChangeK has no FRED equivalent at
  // all (FRED's PAYEMS is a level, not this MoM delta), so it's BLS-only below, gated on `bls` alone.
  const fredOrBls = sourcing.fred || sourcing.bls;
  const mvLabor = (s?: string): string => (fredOrBls && s && s.length > 0 ? s : EM_DASH);
  const mnLabor = (s?: string): number | undefined => (fredOrBls ? numFrom(s) : undefined);
  const laborAsOf = fredOrBls ? macro.asOf : undefined;
  const blsAsOf = sourcing.bls ? macro.asOf : undefined;
  // nonfarmPayrollsChangeK has no FRED equivalent at all — gate it on `bls` alone, never `fred`.
  const mvBls = (s?: string): string => (sourcing.bls && s && s.length > 0 ? s : EM_DASH);

  const cpi = mnLabor(macro.cpiInflation);
  const corePce = mn(macro.corePCE);
  const breakeven = mn(macro.inflationExpectation10y);
  const gdp = mn(macro.realGDPGrowth);
  const vix = sourcing.vix ? numFrom(macro.vix) : undefined;
  const hy = mn(macro.hyCreditSpread);
  const sent = mn(macro.consumerSentiment);
  const m2g = mn(macro.m2GrowthYoY);
  const oil = mn(macro.wtiOil);
  const unemp = mnLabor(macro.unemploymentRate);
  const claims = mn(macro.initialClaims); // thousands
  const starts = mn(macro.housingStarts); // millions

  const curve3m10y = dnRate(derived.curve3m10y);
  const curve2s10s = dnRate(derived.curve2s10s);
  const curvePolicy = dn(derived.yieldCurveSpread);
  const real10Y = dn(derived.real10Y);
  const realFF = dn(derived.realFedFunds);
  const misery = fredOrBls ? derived.miseryIndex : undefined;
  const vixTerm = dn(derived.vixTermStructure);
  const erp = dn(derived.equityRiskPremium);

  const curveReading = (v: number | undefined, extra?: string): string | undefined =>
    typeof v !== "number"
      ? undefined
      : v < 0
        ? `Inverted — short money out-yields long bonds, a classic recession warning.${extra ? ` ${extra}` : ""}`
        : v < 0.5
          ? "Flat — little reward for lending long; markets are unsure about growth."
          : "Upward-sloping — the normal, healthy shape.";

  const rates: Tile[] = [
    {
      key: "fedFunds",
      label: "Fed funds",
      value: mv(macro.fedFundsRate),
      what: "The Fed's overnight policy rate — the anchor every other borrowing cost prices off.  Higher means tighter financial conditions.",
      reading:
        typeof realFF === "number"
          ? realFF > 1
            ? "Well above inflation — a clearly restrictive stance."
            : realFF >= 0
              ? "Slightly above inflation — mildly restrictive."
              : "Below inflation — accommodative in real terms."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "dgs3mo",
      label: "3M T-bill",
      value: mvRate(macro.dgs3moTreasury),
      what: "Three-month Treasury yield — the near risk-free return on cash and the short leg of the Fed's preferred recession curve.  Higher raises the bar every risky asset must clear.",
      asOf: rateAsOf
    },
    {
      key: "dgs2",
      label: "2Y Treasury",
      value: mvRate(macro.dgs2Treasury),
      what: "Two-year Treasury yield — the bond market's bet on where Fed policy goes over the next couple of years.",
      asOf: rateAsOf
    },
    {
      key: "dgs10",
      label: "10Y Treasury",
      value: mvRate(macro.dgs10Treasury),
      what: "Ten-year Treasury yield — the long-term discount rate on future profits.  When it rises, expensive growth stocks feel it most.",
      asOf: rateAsOf
    },
    {
      key: "curve3m10y",
      label: "Curve 3m/10y",
      value: fmtSigned(curve3m10y, " pp"),
      tone: typeof curve3m10y === "number" ? (curve3m10y < 0 ? "neg" : "pos") : undefined,
      what: "10Y yield minus 3-month yield, in percentage points — the Fed's preferred recession curve.  Below zero = inverted.",
      reading: curveReading(curve3m10y),
      asOf: rateAsOf
    },
    {
      key: "curve2s10s",
      label: "Curve 2s10s",
      value: fmtSigned(curve2s10s, " pp"),
      tone: typeof curve2s10s === "number" ? (curve2s10s < 0 ? "neg" : "pos") : undefined,
      what: "10Y yield minus 2Y yield — the canonical “2s10s” curve traders quote.  Below zero = inverted, a recession signal with a long lead.",
      reading: curveReading(curve2s10s),
      asOf: rateAsOf
    },
    {
      key: "curvePolicy",
      label: "10Y − Fed funds",
      value: fmtSigned(curvePolicy, " pp"),
      tone: typeof curvePolicy === "number" ? (curvePolicy < 0 ? "neg" : "pos") : undefined,
      what: "10Y yield minus the policy rate — the inversion this app's regime classifier actually reads.",
      reading: curveReading(
        curvePolicy,
        "This is the input that flips the regime label toward Cautious / Risk-Off."
      ),
      asOf: mAsOf
    }
  ];

  const inflationGrowth: Tile[] = [
    {
      key: "cpi",
      label: "CPI (YoY)",
      value: mvLabor(macro.cpiInflation),
      what: "Consumer-price inflation over the last year.  Hot inflation squeezes margins and valuation multiples.",
      reading:
        typeof cpi === "number"
          ? cpi > 4
            ? "Hot — keeps pressure on the Fed to stay tight."
            : cpi > 2.5
              ? "Above the Fed's 2% goal."
              : "Near (or below) the Fed's 2% goal."
          : undefined,
      asOf: laborAsOf
    },
    {
      key: "corePce",
      label: "Core PCE",
      value: mv(macro.corePCE),
      what: "Inflation excluding food and energy — the gauge the Fed actually targets at 2%.",
      reading:
        typeof corePce === "number"
          ? corePce > 3
            ? "Well above target — argues for tight policy."
            : corePce > 2.2
              ? "Modestly above the 2% target."
              : "At or near the 2% target."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "breakeven10y",
      label: "10Y breakeven",
      value: mv(macro.inflationExpectation10y),
      what: "What bond markets expect inflation to average over the next decade (10Y nominal minus 10Y TIPS).",
      reading:
        typeof breakeven === "number"
          ? breakeven > 2.5
            ? "Markets doubt inflation settles back to 2%."
            : breakeven >= 1.5
              ? "Expectations anchored near the 2% target."
              : "Low — markets flag deflation risk."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "real10Y",
      label: "Real 10Y",
      value: fmtSigned(real10Y, " pp"),
      tone: typeof real10Y === "number" && real10Y > 2 ? "warn" : undefined,
      what: "10Y yield minus CPI inflation — the real risk-free rate that discounts future profits.",
      reading:
        typeof real10Y === "number"
          ? real10Y > 2
            ? "High — a stiff headwind for growth-stock multiples."
            : real10Y >= 0
              ? "Moderately positive — a normal valuation backdrop."
              : "Negative — cash loses to inflation, which historically favors risk assets."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "realFF",
      label: "Real Fed funds",
      value: fmtSigned(realFF, " pp"),
      tone: typeof realFF === "number" && realFF > 1 ? "warn" : undefined,
      what: "Policy rate minus CPI inflation.  Above zero, the Fed is actively braking the economy.",
      reading:
        typeof realFF === "number"
          ? realFF > 1
            ? "Clearly restrictive policy."
            : realFF >= 0
              ? "Mildly restrictive."
              : "Accommodative — policy is easier than inflation."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "gdp",
      label: "Real GDP",
      value: mv(macro.realGDPGrowth),
      what: "Inflation-adjusted economic growth, annualized.  Around 2% is trend for the U.S.",
      reading:
        typeof gdp === "number"
          ? gdp < 0
            ? "Contracting — recession territory."
            : gdp < 1.5
              ? "Below trend — sluggish growth."
              : gdp <= 3
                ? "Around trend."
                : "Above trend — the economy is running hot."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "misery",
      label: "Misery index",
      value: fmtPlain(misery, 1),
      what: "Unemployment plus inflation — a crude, old-school gauge of household pain.",
      reading:
        typeof misery === "number"
          ? misery > 10
            ? "Elevated macro stress on households."
            : misery >= 7
              ? "Moderate."
              : "Low by historical standards."
          : undefined,
      asOf: laborAsOf
    }
  ];

  const risk: Tile[] = [
    {
      key: "vix",
      label: "VIX",
      // Own sourcing flag: even without FRED, the backend fetches a live ^VIX
      // from Yahoo (key-free), so this tile can be real while the rest is blank.
      value: sourcing.vix && macro.vix ? macro.vix : EM_DASH,
      tone: typeof vix === "number" ? (vix > 30 ? "neg" : vix > 20 ? "warn" : vix < 13 ? "pos" : undefined) : undefined,
      what: "Expected S&P 500 volatility over the next 30 days — the market's fear gauge and the regime classifier's primary input.",
      reading:
        typeof vix === "number"
          ? vix > 30
            ? "Above 30 — panic levels; the classifier calls this a Crisis regime."
            : vix > 20
              ? "Above 20 — stressed; Risk-Off territory."
              : vix < 13
                ? "Below 13 — unusually calm; Risk-On territory."
                : "In the normal 13–20 band."
          : undefined,
      asOf: sourcing.vix ? macro.asOf : undefined
    },
    {
      key: "vix3m",
      label: "VIX 3M",
      value: mv(macro.vix3m),
      what: "Expected volatility over the next three months — compared against the 30-day VIX to spot acute, front-loaded stress.",
      asOf: mAsOf
    },
    {
      key: "vixTerm",
      label: "VIX term",
      value: fmtPlain(vixTerm, 2, "×"),
      tone: typeof vixTerm === "number" ? (vixTerm > 1 ? "neg" : "pos") : undefined,
      what: "VIX divided by 3-month VIX.  Above 1, near-term fear exceeds longer-term fear (backwardation) — a stress signature.",
      reading:
        typeof vixTerm === "number"
          ? vixTerm > 1
            ? "Backwardation — acute near-term fear."
            : "Contango — the normal, calm shape."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "skew",
      label: "SKEW",
      value: fmtPlain(signals.skew, 1),
      tone: typeof signals.skew === "number" ? (signals.skew > 145 ? "neg" : signals.skew > 135 ? "warn" : undefined) : undefined,
      what: "Cboe SKEW — how much investors pay for crash protection in S&P options.  Around 100 is normal.",
      reading:
        typeof signals.skew === "number"
          ? signals.skew > 145
            ? "Very elevated demand for crash hedges."
            : signals.skew > 135
              ? "Elevated tail-risk pricing."
              : "Unremarkable tail-risk pricing."
          : undefined
    },
    {
      key: "vvix",
      label: "VVIX",
      value: fmtPlain(signals.vvix, 1),
      tone: typeof signals.vvix === "number" && signals.vvix >= 150 ? "neg" : undefined,
      what: "Volatility of the VIX itself — how unsettled the fear gauge is.",
      reading:
        typeof signals.vvix === "number"
          ? signals.vvix >= 150
            ? "At/above 150 — the default trip level for the optional volatility panic brake."
            : signals.vvix > 110
              ? "Jumpy — volatility itself is volatile."
              : signals.vvix < 90
                ? "Very calm."
                : "Typical."
          : undefined
    },
    {
      key: "hySpread",
      label: "HY credit spread",
      value: mv(macro.hyCreditSpread),
      tone: typeof hy === "number" ? (hy > 5 ? "neg" : hy < 3.5 ? "pos" : undefined) : undefined,
      what: "Extra yield junk-bond investors demand over Treasuries (ICE BofA high-yield OAS) — the credit market's risk appetite.",
      reading:
        typeof hy === "number"
          ? hy > 5
            ? "Wide — credit stress; lenders are pulling back."
            : hy < 3.5
              ? "Tight — healthy risk appetite."
              : "Middling."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "erp",
      label: "Equity risk premium",
      value: fmtSigned(erp, " pp"),
      tone: typeof erp === "number" ? (erp < 0 ? "neg" : erp > 3 ? "pos" : undefined) : undefined,
      what: "The market's earnings yield minus the 10Y — the extra return stocks offer over bonds.",
      reading:
        typeof erp === "number"
          ? erp < 0
            ? "Negative — stocks are priced richer than bonds."
            : erp > 3
              ? "Generous — stocks look cheap next to bonds."
              : "Thin but positive."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "sentiment",
      label: "Consumer sentiment",
      value: mv(macro.consumerSentiment),
      what: "University of Michigan household survey; its long-run average is around 85.",
      reading:
        typeof sent === "number"
          ? sent < 70
            ? "Pessimistic households — spending headwind."
            : sent > 90
              ? "Upbeat households."
              : "Middling."
          : undefined,
      asOf: mAsOf
    }
  ];

  const f = signals.factors1m;
  const positioning: Tile[] = [
    {
      key: "cotNet",
      label: "S&P spec net",
      value: typeof signals.cotSpNonCommNet === "number" ? signals.cotSpNonCommNet.toLocaleString() : EM_DASH,
      tone: toneSign(signals.cotSpNonCommNet),
      what: "Large speculators' net position in E-mini S&P 500 futures (CFTC, weekly and lagged).  Positive = net long.",
      reading:
        typeof signals.cotSpNonCommNet === "number"
          ? signals.cotSpNonCommNet >= 0
            ? "Speculators are net long the index."
            : "Speculators are net short the index — crowded shorts can fuel squeezes."
          : undefined,
      asOf: signals.cotReportDate
    },
    {
      key: "cotPctOi",
      label: "Spec net %OI",
      value:
        typeof signals.cotSpNonCommNetPctOI === "number"
          ? `${signals.cotSpNonCommNetPctOI >= 0 ? "+" : ""}${signals.cotSpNonCommNetPctOI.toFixed(1)}%`
          : EM_DASH,
      tone: toneSign(signals.cotSpNonCommNetPctOI),
      what: "The same net position as a share of total open interest — comparable across time.  Regime context, never a single-stock trigger.",
      asOf: signals.cotReportDate
    },
    {
      key: "mktRf",
      label: "Market (1m)",
      value: fmtSigned(f?.mktRf, "%"),
      tone: toneSign(f?.mktRf),
      what: "Total U.S. market return over cash, trailing ~1 month (Kenneth French data; published with a ~6-week lag).",
      reading: typeof f?.mktRf === "number" ? (f.mktRf >= 0 ? "Stocks beat cash over the window." : "Stocks trailed cash over the window.") : undefined,
      asOf: signals.factorsAsOf
    },
    {
      key: "smb",
      label: "Size (1m)",
      value: fmtSigned(f?.smb, "%"),
      tone: toneSign(f?.smb),
      what: "Small-minus-big factor: positive means small caps are leading large caps — usually a risk-appetite tell.",
      reading: typeof f?.smb === "number" ? (f.smb >= 0 ? "Small caps leading." : "Large caps leading.") : undefined,
      asOf: signals.factorsAsOf
    },
    {
      key: "hml",
      label: "Value (1m)",
      value: fmtSigned(f?.hml, "%"),
      tone: toneSign(f?.hml),
      what: "Value-minus-growth factor: positive means cheap stocks are beating expensive ones.",
      reading: typeof f?.hml === "number" ? (f.hml >= 0 ? "Value in favor." : "Growth in favor.") : undefined,
      asOf: signals.factorsAsOf
    },
    {
      key: "mom",
      label: "Momentum (1m)",
      value: fmtSigned(f?.mom, "%"),
      tone: toneSign(f?.mom),
      what: "Winners-minus-losers factor: positive means recent winners keep winning — trend-following is being paid.",
      reading: typeof f?.mom === "number" ? (f.mom >= 0 ? "Momentum working." : "Momentum reversing — chop.") : undefined,
      asOf: signals.factorsAsOf
    }
  ];

  const liquidity: Tile[] = [
    {
      key: "m2Growth",
      label: "M2 growth (YoY)",
      value: mv(macro.m2GrowthYoY),
      tone: typeof m2g === "number" && m2g < 0 ? "warn" : undefined,
      what: "Year-over-year growth of the M2 money supply — the liquidity tide under asset prices.",
      reading:
        typeof m2g === "number"
          ? m2g < 0
            ? "Contracting — a historically rare liquidity drain."
            : m2g > 5
              ? "Expanding fast — a liquidity tailwind."
              : "Modest growth."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "m2Level",
      label: "M2 supply",
      value: mv(macro.m2MoneySupply),
      what: "Total M2 money supply level — a broad liquidity backdrop; the growth trend matters more than the level.",
      asOf: mAsOf
    },
    {
      key: "usd",
      label: "Broad USD",
      value: mv(macro.usdIndex),
      what: "Broad trade-weighted dollar index (FRED DTWEXBGS, ~120 scale — not DXY).  A strong dollar pressures multinationals' overseas earnings and commodities.",
      asOf: mAsOf
    },
    {
      key: "wti",
      label: "WTI oil",
      value: mv(macro.wtiOil),
      what: "U.S. benchmark crude price — feeds inflation, energy-sector profits, and consumer costs.",
      reading:
        typeof oil === "number"
          ? oil > 90
            ? "Expensive — an inflationary impulse."
            : oil < 60
              ? "Cheap — disinflationary, but can also signal weak demand."
              : "Mid-range."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "unemployment",
      label: "Unemployment",
      value: mvLabor(macro.unemploymentRate),
      what: "Share of the labor force out of work.  A sustained rise is the classic recession confirmation.",
      reading:
        typeof unemp === "number"
          ? unemp < 4
            ? "Historically tight labor market."
            : unemp <= 5
              ? "Near balance."
              : "Softening labor market."
          : undefined,
      asOf: laborAsOf
    },
    {
      key: "nonfarmPayrolls",
      label: "Nonfarm payrolls",
      value: mvBls(macro.nonfarmPayrollsChangeK),
      // No FRED equivalent exists in this MoM-delta shape (FRED's PAYEMS is a level) — BLS-only,
      // so this tile only ever lights up via the keyless/lightly-keyed BLS fallback, never FRED.
      what: "Month-over-month change in total nonfarm payroll employment — the conventional \"jobs report\" headline.",
      reading:
        (() => {
          const change = numFrom(macro.nonfarmPayrollsChangeK);
          if (typeof change !== "number") return undefined;
          if (change < 0) return "Contracting — a real labor-market warning sign.";
          if (change < 100) return "Soft — below the pace needed to keep up with population growth.";
          return "Healthy job growth.";
        })(),
      asOf: sourcing.bls ? blsAsOf : undefined
    },
    {
      key: "claims",
      label: "Initial claims",
      value: mv(macro.initialClaims),
      what: "New unemployment filings each week — the fastest labor-market warning light.",
      reading:
        typeof claims === "number"
          ? claims > 300
            ? "Elevated — the labor market is cracking."
            : claims < 250
              ? "Healthy."
              : "Drifting up — worth watching."
          : undefined,
      asOf: mAsOf
    },
    {
      key: "housingStarts",
      label: "Housing starts",
      value: mv(macro.housingStarts),
      what: "New home construction starts (annualized) — housing is the most rate-sensitive corner of the economy.",
      reading:
        typeof starts === "number"
          ? starts < 1.2
            ? "Weak — tight credit is biting."
            : starts > 1.5
              ? "Strong."
              : "Middling."
          : undefined,
      asOf: mAsOf
    }
  ];

  return [
    {
      id: "rates",
      title: "Rates & yield curve",
      desc: "Treasury yields and curve spreads from FRED (3M/2Y/10Y and their curves also have a key-free Treasury.gov fallback).  An inverted curve (short rates above long rates) is the classic recession warning and feeds the regime label.",
      tiles: rates
    },
    {
      id: "inflation",
      title: "Inflation & growth",
      desc: "Inflation gauges, real (inflation-adjusted) rates, and growth from FRED (CPI also has a key-free BLS fallback — see the misery index below and the labor tiles under Liquidity & economy).  Real rates set the valuation backdrop for stocks.",
      tiles: inflationGrowth
    },
    {
      id: "risk",
      title: "Risk & volatility",
      desc: "Fear gauges (Cboe), credit spreads (FRED), and the stocks-vs-bonds premium.  This group moves first when markets get stressed.",
      tiles: risk
    },
    {
      id: "positioning",
      title: "Positioning & factor regime",
      desc: "Who is positioned where (CFTC futures data, weekly) and which equity styles are being paid (Kenneth French factors, ~6-week lag).  Context, not triggers.",
      tiles: positioning
    },
    {
      id: "liquidity",
      title: "Liquidity & economy",
      desc: "Money supply, the dollar, oil, and the labor/housing pulse — the slower-moving backdrop behind everything above.  Unemployment and nonfarm payrolls also have a key-free BLS fallback when no FRED key is configured.",
      tiles: liquidity
    }
  ];
}

// ── Regime copy ──────────────────────────────────────────────────────────────

export interface RegimeInfo {
  chipTone: "pos" | "neg" | "warn" | "accent" | "muted";
  /** One-word-ish severity chip. */
  chipWord: string;
  /** What this label means, in plain words, including what changes for the strategist. */
  meaning: string;
}

// Typed-enum classification of the persisted label (see src/lib/market-regime.ts — the same
// dependency-free module policy.ts/strategy.ts/regime-watch.ts key their gates off). Falls back to
// a substring match for anything `regimeFromLabel` doesn't recognize as one of the five canonical
// labels (older snapshot payloads, or a future/unexpected label) so this card degrades gracefully
// instead of collapsing every unrecognized string to "no data".
import {
  REGIME_BELOW_MEDIAN_CRISIS,
  REGIME_BELOW_MEDIAN_RISK_OFF,
  REGIME_GATES_ENTRIES
} from "@/lib/guardrail-copy";

export function regimeInfo(regime: string): RegimeInfo {
  const enumRegime = regimeFromLabel(regime);
  const l = regime.toLowerCase();
  const isCrisis = enumRegime === "crisis" || (enumRegime === "unknown" && l.includes("crisis"));
  const isRiskOff = enumRegime === "risk-off" || (enumRegime === "unknown" && l.includes("risk-off"));
  const isCautiousInverted =
    enumRegime === "cautious-inverted" || (enumRegime === "unknown" && (l.includes("inverted") || l.includes("cautious")));
  const isRiskOn = enumRegime === "risk-on" || (enumRegime === "unknown" && l.includes("risk-on"));
  const isUnknown = enumRegime === "unknown" && l.includes("unknown");

  if (isCrisis) {
    return {
      chipTone: "neg",
      chipWord: "escalation",
      meaning: REGIME_BELOW_MEDIAN_CRISIS
    };
  }
  if (isRiskOff) {
    return {
      chipTone: "neg",
      chipWord: "escalation",
      meaning: REGIME_BELOW_MEDIAN_RISK_OFF
    };
  }
  if (isCautiousInverted) {
    return {
      chipTone: "warn",
      chipWord: "escalation",
      meaning:
        "Volatility is calm, but the 10Y Treasury yields less than the Fed's policy rate — a classic late-cycle recession warning.  The optional crisis/inverted exposure cap applies to new positions."
    };
  }
  if (isRiskOn) {
    return {
      chipTone: "pos",
      chipWord: "calm",
      meaning:
        "VIX below 13 with a normal yield curve — unusually calm, trend-friendly markets.  No regime-specific vetoes or caps apply."
    };
  }
  if (isUnknown) {
    return {
      chipTone: "muted",
      chipWord: "no data",
      meaning:
        "No macro feed is available (no FRED key and the key-free VIX lookup failed), so the classifier refuses to guess.  Regime-conditioned caps and vetoes stay neutral."
    };
  }
  return {
    chipTone: "accent",
    chipWord: "normal",
    meaning:
      "Volatility is in its normal band and the yield curve is not inverted.  No regime-specific vetoes or caps apply."
  };
}

/** How the strategist consumes the regime label — shown in the regime card. */
export const REGIME_USAGE: Array<{ title: string; body: string }> = [
  {
    title: "Stamped on every proposal",
    body: "Each trade idea records this label as its entry regime, so Results can score realized performance by the market you entered in."
  },
  {
    title: "Position sizing learns from it",
    body: "Once a thesis has 5+ closed trades inside a regime, the sizer and the expectancy gate read that thesis-in-this-regime track record instead of the thesis average."
  },
  {
    title: "It gates entries",
    body: REGIME_GATES_ENTRIES
  },
  {
    title: "Flips are watched",
    body: "The scheduler re-checks the label on every tick.  A change is recorded to the audit log, and a flip into Risk-Off / Crisis / Inverted can broadcast a material event that triggers a run."
  }
];

// ── Trends (sparkline) definitions ───────────────────────────────────────────

export interface TrendDef {
  key: string;
  label: string;
  suffix: string;
  /** "inverse": rising is bad (red when up). "neutral": direction isn't inherently good/bad. */
  polarity: "inverse" | "neutral";
  what: string;
}

export const TREND_DEFS: TrendDef[] = [
  { key: "tenY", label: "10Y yield", suffix: "%", polarity: "neutral", what: "Ten-year Treasury yield — the long-term discount rate on future profits." },
  { key: "twoY", label: "2Y yield", suffix: "%", polarity: "neutral", what: "Two-year Treasury yield — the market's near-term policy bet." },
  { key: "vix", label: "VIX", suffix: "", polarity: "inverse", what: "The 30-day fear gauge — rising VIX means rising stress." },
  { key: "hyCreditSpread", label: "HY spread", suffix: "%", polarity: "inverse", what: "High-yield credit spread — widening means credit stress building." },
  { key: "usd", label: "Broad USD", suffix: "", polarity: "neutral", what: "Trade-weighted dollar — strength pressures multinationals and commodities." },
  { key: "wti", label: "WTI oil", suffix: "", polarity: "neutral", what: "U.S. benchmark crude price — an inflation input either direction." }
];
