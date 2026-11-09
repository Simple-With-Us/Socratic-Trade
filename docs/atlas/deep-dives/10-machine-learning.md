# Deep Dive 10 — Machine Learning & Continuous Learning

> Expert panel deep-dive expanding §10 of the [Multi-Expert App Analysis](../multi-expert-app-analysis.md). Written for a team that is **newer to ML**, building an AI trading/financial-assistant. The overriding theme: markets are low signal-to-noise and non-stationary; ML is an edge-finder and assistant, not a money printer, and **a model is worthless until it beats a naive baseline out-of-sample, after costs.**

---

### 10.1 ML Foundations & Team Learning Path

> **The one warning that overrides everything else.** Markets are *low signal-to-noise* and *non-stationary*: most of price data is noise, and whatever pattern exists keeps changing. The naive "predict tomorrow's price" project fails for almost everyone. Frame ML as **edge-finding and assistance**, and hold every model to one rule: **a model is worthless until it beats a dumb baseline on data it has never seen, after costs.** (For prices, the dumb baseline is "tomorrow ≈ today"; if your model can't beat it out-of-sample, you've built an expensive way to be wrong.)

#### A. The learning path (in order), with the *minimum* math

1. **Supervised vs unsupervised — know which problem you have.** Most finance ML you'll start with is supervised *classification* (predicting a direction/bucket is far more robust than predicting an exact price).
2. **Train / validation / test — the single most important habit.** Split chronologically, never randomly:
   ```python
   df = df.sort_values("date"); n = len(df)
   train = df.iloc[: int(0.7*n)]; val = df.iloc[int(0.7*n): int(0.85*n)]; test = df.iloc[int(0.85*n):]
   ```
3. **Loss vs metrics** — loss is what the model minimizes; metrics are how *you* judge success in business terms. Define the metric before training; compute it for the baseline too.
4. **Bias–variance / overfitting** — in finance, overfitting is the *default* outcome (there's so much noise to memorize). Watch the train-vs-test gap.
5. **Regularization** — fewer features + more regularization is almost always the right instinct in markets.
6. **Gradient descent** — just the intuition (a hiker stepping downhill at a learning rate); libraries do the calculus.
7. **Evaluation** — compare to baseline on held-out test; for time series use walk-forward, not plain k-fold.

Minimum math: mean/variance/std, reading a probability, correlation≠causation, the shape of a function having a minimum. Skip (for now): matrix calculus, manual backprop, optimization proofs.

#### B. Starter tech stack (and why to resist deep learning)

Python → **pandas** (you'll spend ~70% of time here) → NumPy → **scikit-learn** (your workhorse for months) → matplotlib → notebooks (explore) → scripts → pipelines. **PyTorch later**, once a scikit-learn baseline exists that you're trying to beat for a concrete reason. Deep learning overfits noisy financial data more, needs more data/tuning, and is harder to debug — a logistic regression you can audit beats a black box you can't.

```python
from sklearn.linear_model import LogisticRegression
from sklearn.dummy import DummyClassifier
from sklearn.metrics import accuracy_score
baseline = DummyClassifier(strategy="most_frequent").fit(X_train, y_train)
model    = LogisticRegression(max_iter=1000).fit(X_train, y_train)
print("baseline:", accuracy_score(y_test, baseline.predict(X_test)))
print("model:   ", accuracy_score(y_test, model.predict(X_test)))
# If 'model' isn't clearly above 'baseline', you have NOT learned anything useful.
```

#### C. Starter project milestones (real skill, zero money at risk; historical data only)

1. **Baseline-vs-model bake-off (next-day direction)** — success = an honest chronological test-set comparison you can state in one sentence (correctly concluding "no edge" is a passing grade).
2. **Next-day volatility bucket (low/med/high)** — volatility clusters and is far more predictable than direction; beat the "tomorrow's bucket = today's bucket" baseline with a confusion matrix.
3. **News/headline sentiment classifier** — beat a keyword-list baseline; show 5 right and 5 wrong with reasons.
4. **Honest walk-forward backtest of a simple rule** — *with* transaction costs and slippage; feel how costs and look-ahead destroy paper edges.

The real graduation test: a teammate can re-run your pipeline from raw data and get the same number.

#### D. The top beginner mistakes (recognize + avoid)

1. **Data leakage** — a feature secretly contains the answer/future info. For every feature ask "could I compute this at decision time?"
2. **Random k-fold on time series** — use `TimeSeriesSplit`, never shuffle.
3. **P-hacking across many trials** — form a hypothesis first; count every variant; demand the survivor hold on a fresh period.
4. **No baseline** — compute the naive baseline *every time*; the model's worth is the *gap*.
5. **Train/test contamination** — fit scalers/imputers/selectors on **train only**; use a `Pipeline`.
6. **Look-ahead bias** — timestamp by *when knowable*; lag features; include delisted names.
7. **Evaluating on the wrong metric** — pick the metric matching the cost of being wrong; define it before training.
8. **Overfitting to backtests** — keep a final hold-out looked at *once*; treat a beautiful backtest as a *warning sign*.

The thread through all eight: a way of accidentally letting the model see the answer or fooling yourself with noise. When a result looks too good, assume "I leaked something," not "I found alpha."

#### E. Curated "learn this" resources

*Hands-On Machine Learning* (Géron — do the scikit-learn half first); *An Introduction to Statistical Learning* (free PDF — concepts backbone); Andrew Ng's ML Specialization; fast.ai (when ready for PyTorch); *Advances in Financial Machine Learning* (López de Prado — read *second*, the authoritative treatment of finance-specific traps); the scikit-learn User Guide; "A Few Useful Things to Know About Machine Learning" (Domingos — short, free, re-read quarterly).

---

### 10.2 Time-Series & Forecasting (done right)

#### 1. Naive baselines are the bar — beat them or stop

For **prices**, the naive baseline is *last value* (random walk); for **returns**, the *historical mean* (~0 at short horizons).

```python
y_pred_naive = prices.shift(1)                       # price baseline
r = np.log(prices).diff()                            # log-returns
skill = 1 - mae_model/mae_naive                      # >0 means you beat naive
```

Evaluating a price model with R² on *price levels* gives a gorgeous fake 0.999 (the random walk fooling you). **Evaluate predictions of returns against the return baseline.**

#### 2. Stationarity — model returns, not prices

Prices are non-stationary (unit root); use **log-returns** (additive, roughly symmetric). Caveats: over-differencing destroys long-memory (López de Prado's *fractional differentiation* keeps stationarity *and* memory); even returns are only *locally* stationary — plan for retraining and regime detection.

```python
from statsmodels.tsa.stattools import adfuller
adfuller(prices.dropna())[1]   # high p -> non-stationary
adfuller(logret.dropna())[1]   # low p  -> stationary, model this
```

#### 3. Time-series cross-validation — random k-fold is forbidden

Use **forward-chaining** (`TimeSeriesSplit`); expanding window (uses all history) or rolling window (adapts to drift — usually preferred). **Purging & embargo** when labels overlap: if the label at *t* spans a forward window, drop training samples whose label window overlaps the test period (purge) plus a small gap after (embargo). This is the single most common source of fake performance in finance ML.

```python
from sklearn.model_selection import TimeSeriesSplit
for tr_idx, te_idx in TimeSeriesSplit(n_splits=5, gap=5).split(X):   # gap=5 -> 5-day embargo
    ...  # test fold always strictly later than train
```

#### 4. Forecast volatility and distributions, not point prices

Returns are nearly unpredictable; **volatility clusters** and is far more forecastable. EWMA (cheap, strong baseline), GARCH-family (models clustering), realized vol. **Predict distributions/intervals, not point estimates**, and score honestly (pinball/quantile loss, calibration — of your stated-90% intervals, ~90% should contain y). A miscalibrated-but-confident model sizes positions wrong; track coverage as a first-class metric.

#### 5. Classical baselines before deep learning

Climb the ladder, stop when something beats naive: naive → exponential smoothing/ARIMA → **gradient-boosted trees on lagged features** (the workhorse; most real signal in tabular financial ML). Deep nets (Temporal CNN, patch-Transformers) only after GBTs plateau and you have large data + genuine structure + leakage-avoidance maturity. LSTMs are mostly legacy.

#### 6. Feature construction — and the leakage trap in each

```python
r = np.log(prices).diff()
X["ret_lag1"] = r.shift(1); X["ret_lag5"] = r.shift(5)
X["vol_20"]  = r.shift(1).rolling(20).std()   # shift(1) first => no current bar
X["mom_10"]  = r.shift(1).rolling(10).sum()
```

Traps: **centered windows are catastrophic** (`rolling(center=True)` or any rolling without a `shift(1)` peeks); the label leaking into features; resampling/`ffill` carrying future values back; indicator libraries that "smooth" with future data.

#### 7. Honest evaluation — backtest ≠ forecast

Out-of-sample walk-forward only; **multiple-testing/selection bias** (try 100 strategies, ~5 look significant by luck — deflate with Deflated Sharpe and Probability of Backtest Overfitting; log every experiment); Sharpe with realistic costs/slippage/capacity (a Sharpe of 2.0 in a backtest is a red flag to audit); treat every backtested edge as an upper bound.

#### 8. TS-specific pitfalls checklist

Look-ahead via centered windows (#1 killer); normalization fit on the full series (fit `StandardScaler` on train only, inside each fold); survivorship bias (point-in-time/delisting-adjusted universes); train/test contamination via any statistic over all data; restatements & point-in-time fundamentals; timestamp alignment (a "daily close" feature available only after the close can't trade that close); overlapping labels inflating sample size (purge/embargo and down-weight).

**Bottom line:** beat the naive baseline on out-of-sample *returns*, forecast volatility/distributions with honest calibration, validate strictly walk-forward with purging, exhaust classical models before deep learning. Most "AI trading" failures are leakage and evaluation failures, not modeling failures.

---

### 10.3 NLP on Financial Text (sentiment, filings, events)

One of the highest-ROI, most learnable ML areas. The hard parts are timestamps, labels, and proving the signal predicts returns.

#### A. The build-vs-buy ladder (stop when "good enough")

1. **LLM as a zero/few-shot feature extractor (start here)** — no training, working signal in an afternoon. Prompt for *structured* fields (JSON), `temperature=0` for reproducible features, pin the model version, validate the JSON. Highest quality per unit of effort; highest per-item cost.
2. **Embeddings + a light classifier (when you need scale/cost control)** — embed once, train a cheap classifier on top. Powerful pattern: **use Rung 1 to label data, Rung 2 to serve it** (distillation — LLM-quality labels at logistic-regression cost).
3. **Fine-tune a small encoder (FinBERT-style) only when justified** — when volume × latency × cost beats the API bill and you have thousands of labels. Later optimization, not a starting point.

#### B. Tasks that add value

Headline/filing sentiment; **event extraction** (guidance change, M&A, litigation — events move prices more than tone); **novelty/surprise detection** (the *new* part is what's priced — compare each doc to a baseline); **entity/ticker linking** (load-bearing — resolve to a stable ID like CIK/FIGI, not a raw ticker string); structured summarization of 10-K/Q/transcripts into *fields*, not paragraphs.

#### C. Point-in-time features (no look-ahead)

> **A feature's timestamp is when the information became *public*, not the period it describes and not when you scraped it.** Use SEC `acceptanceDateTime`, not the report date; the news publisher timestamp; align to the *next* tradeable bar after the public timestamp + a processing lag.

```python
df["public_ts"] = pd.to_datetime(df["acceptance_datetime"], utc=True)
LAG = pd.Timedelta("1min")
feat_bar = bars.index.searchsorted(df["public_ts"] + LAG)   # next bar, no peeking
df["effective_bar"] = bars.index[feat_bar]
```

Audit with a test asserting `effective_bar > public_ts` for every row.

#### D. Labeling when you have no labels

(1) **Weak/distant supervision** (label by next-day return sign — cheap but noisy and partly circular; bootstrap only, never your eval set); (2) **LLM-assisted labeling** (best bulk source — reads the *text*, not the outcome); (3) **human-in-the-loop** on disagreements/low-confidence; (4) build a small **gold eval set** (200–500 hand-labeled, stratified, never trained on).

#### E. Evaluation — two layers, both mandatory

**Layer 1 — is the text model correct?** Per-class precision/recall/F1 + confusion matrix (overall accuracy hides a useless "always neutral" model). **Layer 2 — does the signal predict anything?** (the step teams skip). Correlate features with *forward* returns out-of-sample — report the **Information Coefficient** (rank correlation of feature vs forward return) and check it survives cost-aware backtesting. A small but stable IC (0.02–0.05 with positive IC information-ratio) can be tradeable; a high in-sample IC that vanishes is overfitting or leakage.

#### F. Pitfalls

Leakage via post-event text (articles get *updated* — pin to original time/content); ticker ambiguity ("ALL" = Allstate vs the word "all"); sarcasm/negation/hedging; distribution shift (retrain on IC decay, not the calendar); over-trusting the score (calibrate it, size by confidence); survivorship in news coverage (delisted names go dark right when they matter).

---

### 10.4 MLOps, Evaluation & Reproducibility

> A result you cannot regenerate is a rumor, not a finding.

#### 10.4.1 Reproducibility basics (week one)

Fix every seed (one place); pin dependencies exactly (a lockfile, not loose ranges); version data snapshots immutably by content hash (markets get *revised* — "AAPL on 2021-03-01" depends on when you pulled it); put all knobs in a config file; write a **run manifest** (timestamp, git commit + dirty flag, config hash, python/lib versions, metrics); make the pipeline deterministic end-to-end (run twice, assert output hashes match).

#### 10.4.2 Experiment tracking & a lightweight registry

Adopt a tracker early (MLflow from a local SQLite file, or W&B). Log on **every** run: params, **data version**, **code hash**, metrics, and artifacts (config, model, equity curve). Promote specific runs to named stages (`Staging`/`Production`/`Archived`) — the registry is also your **rollback path** (keep the prior Production version archived, not deleted).

#### 10.4.3 A simple but correct evaluation protocol

Never shuffle time — split chronologically (train past / test recent). Walk-forward (rolling) evaluation gives many out-of-sample windows. **Embargo** between train and test (drop N days if a label needs N future days). Keep a **lockbox holdout** touched exactly once before go-live. Report metrics with **bootstrap confidence intervals** — "Sharpe 1.42, 95% CI [0.31, 2.45]"; a CI straddling zero is the analysis telling you the truth.

#### 10.4.4 Point-in-time correctness (a starter "feature store")

At training time, a feature may only use information available at that timestamp. Two traps: restated fundamentals (use the value *known then*) and as-of vs event timestamps. The starter pattern is a disciplined Parquet layout + an **as-of join** (`pd.merge_asof(..., direction="backward")`). **Stop training/serving skew** with one pure `make_features(raw)` function imported by both the training job and the live server.

#### 10.4.5 Production monitoring & drift detection

Monitor four things: feature drift (input distribution moved — `ks_2samp`), prediction drift (output distribution moved), performance decay (live Sharpe/hit-rate once labels mature), and **live-vs-backtest tracking error** (the canary that catches everything — run the same model on live and equivalent historical paths; divergence beyond a threshold = skew, bug, or regime change). Tier alerts (Warn vs Page); log every prediction with inputs + timestamp from day one.

#### 10.4.6 CI for ML (gates that block a bad promotion)

Four gate types that *fail the build*: data validation (schema, ranges, nulls, duplicate timestamps); **leakage tests** (no future info; train/test don't overlap; embargo enforced; a feature with `|corr|>0.95` to the target is usually leakage); **baseline-beating gate** (beat buy-and-hold/last-value/always-flat out-of-sample); **model regression** (not materially worse than current production on the frozen eval set). Promotion to `Production` happens only when all gates pass.

#### 10.4.7 Batch vs online learning (default to batch)

Default: scheduled batch retraining from versioned snapshots → full eval + CI gates → promote. Be very cautious with online learning (chases noise, hard to reproduce, a single bad tick poisons it, evades your gates). Safe middle ground: keep the model fixed between scheduled retrains but let *features* update on fresh data.

#### 10.4.8 Pitfalls

Training/serving skew (one shared `make_features`); silent data drift (monitors + alerts); evaluating on contaminated data (time-ordered splits, embargo, untouched lockbox); lookahead/restated data (PIT as-of joins); no rollback path (archive the prior Production version); promoting a sub-baseline model (baseline gate); non-reproducible backtest (seeds + lockfile + snapshot + manifest); online-learning whipsaw (default to batch).

**One line:** version everything that feeds a result, never let the model see the future, always compare against a dumb baseline with a confidence interval, and keep last week's model one click away.

---

### 10.5 Feature Engineering & Data-Leakage Prevention

> Leakage is the #1 reason a beginner's backtest shows a 3.0 Sharpe and then loses money live. Treat every impressive result as guilty until proven innocent.

**What leakage is:** the model, at training time, sees information that wouldn't be available when it has to make a real prediction. Mental model: **stand at timestamp `t` where you'd trade, cover everything dated after `t`. Can the feature still be computed? If not, it's leaking.**

**Taxonomy (high→low impact):** target/label leakage (a feature is a proxy for the answer — AUC ~1.0); look-ahead bias (today's adjusted close adjusted for a split announced next week); temporal leakage via overlapping labels (adjacent samples share forward windows — fix with **purge + embargo**); train/test contamination (random split on time series; fitting a selector/encoder/PCA on the full set); normalization fit on full data; survivorship bias (backtesting on *today's* index constituents); group leakage (correlated rows in both train and test). Plus finance-specific: point-in-time universe, corporate-action adjustment leakage, vendor/restatement leakage (use the *vintage* available then), cross-sectional scaling leak (z-score **within each date**).

**Point-in-time discipline** — two clocks (event time vs information-available time); join/filter/lag on information-available time; store vintages; use as-of joins:

```python
feat = pd.merge_asof(prices.sort_values("ts"), fund.sort_values("available_ts"),
    left_on="ts", right_on="available_ts", by="symbol",
    direction="backward", allow_exact_matches=False)   # strictly BEFORE ts
```

And **lag everything**:

```python
X = df[["feat_mom"]].shift(1)            # the load-bearing line: feature uses only data before the action
y = df["close"].pct_change().shift(-1)   # label: NEXT day's return
```

**Non-leaky feature palette:** lagged returns; trailing rolling volatility/ATR; momentum (12-1, MA crossovers on *closed* bars); **cross-sectional ranks within a single date** (`df.groupby("date")["feat"].rank(pct=True)`); calendar/seasonality (genuinely known ahead); point-in-time text sentiment; trailing regime/liquidity indicators.

**Target/label design:** pick the horizon first (it dictates purge/embargo size); fixed-horizon (overlaps at daily frequency with h>1); **triple-barrier** (upper/lower/vertical — economically meaningful, explicit end time for purging); handle class imbalance *inside the fold*.

**Scale/encode inside CV folds** — every learned transform fit on the training fold only; use a `Pipeline` so CV re-fits per fold. Ban `StandardScaler().fit_transform(X)` before splitting.

**A test harness to CATCH leakage:** (1) shuffle/permutation-target test (shuffle y, retrain — performance should collapse to chance); (2) time-shift/placebo test; (3) **train-on-future/test-on-past should FAIL** (a healthy causal model performs *worse*); (4) single-feature AUC sanity check (any feature with AUC ≈ 0.95–1.0 is a red flag); (5) feature-importance autopsy; (6) ablation; (7) gap/embargo stress test; (8) live-vs-backtest reconciliation.

**The "too good to be true" smell test:** a genuine equity strategy might earn Sharpe ~0.5–1.5; sustained Sharpe > 2–3 from a beginner's first backtest is almost always leakage. Equity curve too smooth, hit rate implausibly high, performance vanishing under a 1-bar execution lag or realistic costs — all leakage signatures. **Default stance: implausibly good = leaky until proven otherwise.**

---

### 10.6 Reinforcement Learning & Sequential Decisions (honest guide)

> An end-to-end "RL agent that learns to trade for profit" is, for a small team new to ML, almost always a trap.

**Why end-to-end RL trading is a trap:** sample inefficiency (RL wants millions of trials; ~10 years of daily data is ~2,500 decisions); non-stationarity (RL assumes fixed rules; markets break them); **sim-to-real gap** (your simulator rarely models fees/slippage/impact/partial fills, so the agent learns strategies profitable only because the sim is too kind); reward hacking (it optimizes the *literal* reward — reward raw PnL and it takes hidden tail risk); catastrophic overfitting to the one historical path.

**Where sequential-decision methods DO help (lowest risk first):** **contextual bandits for product personalization** (which insight/suggestion to surface — fast feedback, abundant, low-stakes; the highest-ROI use); **execution/optimal order slicing** (the signal is fixed and human-approved; RL only optimizes the *how*, inside tight limits); **position sizing under a fixed signal**. The pattern: humans/validated models own *whether and what to trade*; sequential methods optimize the bounded *how much / how / which-to-show*.

**Core concepts:** state/action/reward/policy/value; exploration vs exploitation. **The reward function is the hardest part** — "write the reward, then ask what's the dumbest behavior that maximizes it, because the optimizer will find it." **Proxy-reward danger** (optimizing "engagement" diverges from "user wellbeing"). **Off-policy evaluation** (estimate a new policy from logged data via inverse propensity weighting — which is why you must log action probabilities).

**Contextual bandits — the pragmatic entry point** (RL collapsed to one step; A/B testing on steroids that conditions on the user). Thompson sampling (sample from each arm's value distribution, play the best sample — self-annealing exploration) or UCB. **Evaluate offline before shipping** via IPS on logged traffic. Guardrails: never let any arm's probability hit zero; cap concentration speed; watch a guardrail metric (trust/retention) alongside the click-y reward.

**If you still pursue RL for trading research:** a realistic simulator or nothing (fees/spread/slippage/impact/partial fills/latency/queue); no look-ahead ever; out-of-sample *and* out-of-regime testing (walk-forward + distinct regimes); backtest reward ≠ live edge; conservative position limits *outside* the agent; the same human-confirmed, advisory-only boundary — **no autonomous live trading.**

**Bottom line:** ship a contextual bandit for assistant personalization; use classical bounded control (Almgren–Chriss execution, capped sizing) for the *how* of human-approved trades; keep RL-for-profit in the "prove it for years before trusting it" bucket.

---

### 10.7 Signal Combination, Ensembling & Portfolio Construction

Everything *after* you have a model that emits a number: turning it into a trade, blending it with other signals, shaping a portfolio that survives costs.

#### 10.7.1 Turning predictions into positions (highest leverage)

A model output is not a trade. Pipeline: signal → (calibrate) → (size) → (constrain) → position; keep stages separate. **From signal to size:** threshold + fixed size (transparent baseline — if a fancy sizer can't beat it on net OOS Sharpe, it's noise) → proportional (`w ∝ (p−0.5)`, always capped) → Kelly-style/vol-targeted (size so the *portfolio* hits a target volatility; fractional Kelly ¼–½).

**Meta-labeling — the clean alternative to brute-force tuning:** a **primary** model decides *side* (tuned for recall); a **meta** model predicts *P(the primary call is correct)* from context (vol regime, recent hit-rate, spread) and that becomes the **bet size** (tuned for precision). Separates concerns, is interpretable, and directly attacks false positives (usually what kills live P&L). The meta-label target is built after the fact (1 if acting on the call would hit the profit target before the stop), respecting the same triple-barrier logic or you leak.

**Calibration — make confidence mean what it says.** Tree ensembles and neural nets are routinely overconfident; uncalibrated probabilities corrupt every sizing rule. Diagnose with a reliability curve; fix with Platt scaling or isotonic regression *on a held-out calibration slice*; track Brier/log-loss, not just AUC.

```python
from sklearn.calibration import CalibratedClassifierCV
calibrated = CalibratedClassifierCV(base_model, method="isotonic", cv="prefit")
calibrated.fit(X_calib, y_calib)          # X_calib disjoint from train AND test
```

#### 10.7.2 Ensembling done right

Averaging *diverse, decorrelated* models cancels idiosyncratic errors while preserving shared signal — the diversity is the point. **Bagging** reduces variance, **boosting** reduces bias (overfits noisy labels — regularize + early stop), **stacking** can do both but **easily overfits the combiner** (the single easiest place to manufacture a fake backtest). **Simple averaging is a strong, robust default** (no parameters to overfit; frequently beats a learned combiner OOS). Combining heterogeneous signals (momentum + sentiment + fundamentals): normalize each to a common space (cross-sectional z-score per timestamp), weight by conviction not count, prefer economically-motivated weights.

#### 10.7.3 Cross-sectional vs time-series, ranking & risk-neutralization

**Time-series** ("will *this* asset go up?") vs **cross-sectional** ("which assets out-perform *each other*?" — more robust to market-wide moves; how most factor strategies work). **Learning-to-rank** (`LGBMRanker`/LambdaMART) when you only trade top/bottom-k — you need the ordering right, not accurate return predictions. **Neutralize to common risk factors** — regress your signal on factor exposures and keep only the residual, or you're paying alpha fees for cheap beta and exposed to factor drawdowns you didn't intend.

```python
beta, *_ = np.linalg.lstsq(F, signal, rcond=None)
alpha_residual = signal - F @ beta      # the part factors can't explain -> trade THIS
```

#### 10.7.4 Portfolio construction from signals

Simplest first: **equal-weight/equal-risk** (almost nothing to overfit; shockingly hard to beat net of costs) → **risk parity** (ignores the noisy expected-return estimates) → **mean-variance** (theoretically optimal, practically an *error-maximizer* — shrink Σ with Ledoit-Wolf, constrain hard). **Turnover-/cost-aware optimization:** `maximize wᵀ·signal − λ_risk·wᵀΣw − λ_cost·‖w − w_prev‖₁` — the L1 turnover term creates a no-trade band and often does more for live Sharpe than any modeling improvement. Apply constraints (per-name caps, sector neutrality, gross/net limits, liquidity caps) *inside* the optimizer, not as a post-hoc clip.

#### 10.7.5 Honest evaluation of the combined system

A combiner can launder leakage from any input. True walk-forward (re-fit base models, calibration, combiner, *and* portfolio params only on past data); **deflate** metrics (a Sharpe of 2 from 1,000 configs is not a Sharpe of 2); factor attribution on the final P&L (if most return is market/momentum/sector beta, you built a factor ETF); net of realistic costs; prefer stability across sub-periods/regimes over a dazzling peak.

#### 10.7.6 Pitfalls

Overfitting the combiner weights (default to equal weight; make a learner earn its complexity OOS); double-counting correlated signals (three momentum variants ≈ one at 3× weight — check the signal correlation matrix); leakage through the combiner's training (nested/purged embargoed CV); calibration drift; ignoring costs & turnover; sizing on uncalibrated probabilities; neutralization skipped (un-neutralized signals smuggle in beta); one headline number hiding regime fragility.
