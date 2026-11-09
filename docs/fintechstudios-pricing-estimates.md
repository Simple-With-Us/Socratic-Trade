# Fintech Studios Pricing & Estimation Guide

This document records the subscription tiers, credit costs, and usage estimates for the Fintech Studios (PowerIntell.AI) integration in the trading bot.

## 1. Subscription Tiers
Fintech Studios offers the following credit plans:
- **Free Tier**: $0/mo — 800 credits/mo
- **Starter Tier**: $20/mo — 2,500 credits/mo (unused credits roll over up to 1,500)
- **Pro Tier**: $40/mo — 5,000 credits/mo
- **Growth Tier**: $120/mo — 15,000 credits/mo

*Note: There is a 20% discount if billed annually.*

## 2. API Operation Credit Costs
- **Symbol Search (`/api/v1/search`)**: 6 credits per call (returns 25 articles).
- **AI Summary (`/api/v1/summaries`)**: 5 credits per call.

## 3. Monthly Run Projections
Estimates for a **5-ticker portfolio** (e.g. AAPL, MSFT, NVDA, AMZN, GOOG):

### Scenario A: Once-Daily EOD Scan (22 trading days/mo)
- **Calculation**: 5 tickers × 22 days = 110 searches/mo
- **Credit Cost**: 110 × 6 = **660 credits/mo**
- **Plan Recommended**: **Free Tier ($0/mo)**

### Scenario B: Active Intra-Day Trading (3 scans/day)
- **Calculation**: 5 tickers × 3 scans/day × 22 days = 330 searches/mo
- **Credit Cost**: 330 × 6 = **1,980 credits/mo**
- **Plan Recommended**: **Starter Tier ($20/mo)**

### Scenario C: High-Frequency / Broad Universe (10+ scans/day)
- **Calculation**: 5 tickers × 10 scans/day × 22 days = 1,100 searches/mo
- **Credit Cost**: 1,100 × 6 = **6,600 credits/mo**
- **Plan Recommended**: **Pro Tier ($40/mo)** or higher
