import type { StrategyEvalCase } from "./strategy-score";

/**
 * Strategy offline-eval dataset (Chat A item 2). Each case is a FIXED fixture of what a Bull/Bear
 * model "returned" this run, scored deterministically (no LLM) against the three money-path
 * invariants in strategy-score.ts. Every case here is CORRECT — the runner asserts they all pass, so
 * a prompt/schema regression that lets a violating shape through would flip a case red. (The scorers'
 * teeth — that they FAIL bad output — are proven in test/run-strategy-offline.test.ts.)
 */
export const STRATEGY_DATASET: StrategyEvalCase[] = [
  {
    id: "bull-in-universe-buys",
    step: "bull",
    description: "In-universe buys with supportive evidence; short-selling disabled, no shorts.",
    universe: ["AAPL", "MSFT", "NVDA"],
    shortSellingEnabled: false,
    regime: "Neutral (Normal Volatility)",
    modelOutput: {
      proposals: [
        { symbol: "AAPL", side: "buy", type: "market" },
        { symbol: "MSFT", side: "buy", type: "limit" }
      ]
    },
    evidence: {
      AAPL: { score: 82, medianScore: 60, fcfYield: 4.5, debtToEquity: 0.8 },
      MSFT: { score: 78, medianScore: 60, fcfYield: 3.2, debtToEquity: 0.5 }
    },
    vetoThresholds: { fcfYieldFloorPct: 0, debtToEquityCeiling: 3 }
  },
  {
    id: "bull-short-with-stop",
    step: "bull",
    description: "Short-selling enabled; the short carries a mandatory stop and the buy is supported.",
    universe: ["TSLA", "AAPL"],
    shortSellingEnabled: true,
    regime: "Neutral (Normal Volatility)",
    modelOutput: {
      proposals: [
        { symbol: "TSLA", side: "short", type: "stop_market", stopPrice: 260 },
        { symbol: "AAPL", side: "buy", type: "market" }
      ]
    },
    evidence: {
      TSLA: { score: 40, medianScore: 55 },
      AAPL: { score: 80, medianScore: 55, fcfYield: 4.0, debtToEquity: 0.8 }
    },
    vetoThresholds: { fcfYieldFloorPct: 0, debtToEquityCeiling: 3 }
  },
  {
    id: "bull-riskoff-above-median-only",
    step: "bull",
    description: "Risk-off regime; only an above-median, FCF-positive buy is proposed.",
    universe: ["XLU", "AAPL"],
    shortSellingEnabled: false,
    regime: "Risk-Off (High Volatility)",
    modelOutput: { proposals: [{ symbol: "XLU", side: "buy", type: "market" }] },
    evidence: { XLU: { score: 75, medianScore: 60, fcfYield: 5.0, debtToEquity: 1.0 } },
    vetoThresholds: { fcfYieldFloorPct: 0, debtToEquityCeiling: 3 }
  },
  {
    id: "bear-survivors-with-exempt-exit",
    step: "bear",
    description: "Bear survivors include a SELL of an off-universe held name — exits are exempt from the universe gate.",
    universe: ["AAPL"],
    shortSellingEnabled: false,
    regime: "Neutral (Normal Volatility)",
    modelOutput: {
      proposals: [
        { symbol: "AAPL", side: "buy", type: "market" },
        { symbol: "OLDCO", side: "sell", type: "market" }
      ]
    },
    evidence: { AAPL: { score: 70, medianScore: 55, fcfYield: 4.0, debtToEquity: 0.9 } },
    vetoThresholds: { fcfYieldFloorPct: 0, debtToEquityCeiling: 3 }
  }
];
