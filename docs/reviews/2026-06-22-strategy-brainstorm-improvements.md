# 🧠 Strategy Brainstorm & Handoff — Strategy Improvements

**Date:** 2026-06-22  
**Sender:** Antigravity (Gemini)  
**Recipient:** Claude / Human Reviewer  
**Context File:** [strategy.ts](file:///Users/jay/apps/trading-antigravity/src/lib/strategy.ts)

---

## 1. Overview & Core Objective
This document outlines the output of a multi-disciplinary financial expert panel (Quant PM, CRO, Execution Microstructure, and ML Trader) convened to identify specific, actionable improvements to our trading strategy. Claude can use this specification to select, design, and implement the next set of strategy improvements.

---

## 2. Expert Panel Findings & Specifications

### A. Cost-Aware Sizing & expectancy Haircuts (Quant PM)
*   **The Problem:** The Kelly-lite sizing formula in `applyDeterministicSizing` is cost-blind. It sizes trades based on raw historical win rate and return expectancy without subtracting bid-ask spread or market slippage. In a high-turnover model, transaction costs will bleed expected edge.
*   **Actionable Enhancement:** 
    *   Inject dynamic spread and estimated transaction costs into the sizing calculation.
    *   Subtract estimated slippage and commission from the historical average return of a thesis before applying the Kelly factor.
    *   If the net expected return is negative, override position size to $0$.

### B. Correlation & Covariance Cluster Penalties (CRO)
*   **The Problem:** The strategy evaluates candidate equities independently. If the LLM proposes buying multiple highly correlated assets (e.g., three major tech stocks), the system sizes them independently, exposing the portfolio to severe cluster concentration.
*   **Actionable Enhancement:**
    *   Compute a correlation/covariance penalty for new candidates based on existing holdings.
    *   If the portfolio's net exposure to a high-correlation cluster (derived from daily return covariance) exceeds a target threshold, scale down the size multiplier for additional entries in that cluster.

### C. Broker-Held bracket Orders (Execution Expert)
*   **The Problem:** Stop-loss and take-profit targets are synthetically monitored and executed via local scheduler polling. If the local server drops offline or crashes, no protective exits will execute at the broker.
*   **Actionable Enhancement:**
    *   Modify the order placement path to utilize native **broker-held OCO (One-Cancels-Other) brackets**.
    *   When placing a market/limit entry via Alpaca or Robinhood MCP, attach the target exit and stop-loss directly to the initial order payload, transferring execution risk to the exchange's matching engine.

### D. Walk-Forward out-of-Sample Validation (ML Trader)
*   **The Problem:** Auto-tuning factor weights based on the same historical data used to generate trades leads to severe in-sample overfitting.
*   **Actionable Enhancement:**
    *   Implement a walk-forward splits framework in the learning database.
    *   Ensure the auto-tuner validates suggested factor weight updates on out-of-sample periods before suggesting changes to the user.

---

## 3. Recommended Next Implementation Steps for Claude
1.  **Spread Tracking:** Wire bid/ask quote spread data into `reviewEquityOrder` and `applyDeterministicSizing`.
2.  **Slippage Haircut:** Update `applyDeterministicSizing` to calculate net expected return by subtracting the transaction cost fraction from the historical thesis expectancy.
3.  **Broker Bracket Integration:** Adapt `gateway.placeEquityOrder` to optionally receive and route stop-loss/take-profit targets to native broker brackets.
