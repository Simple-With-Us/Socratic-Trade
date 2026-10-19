// Server-only content for the /framework page.
//
// IMPORTANT: this module must never be imported from a client component. The
// framework prose is deliberately kept out of the HTML document and out of
// every client JS chunk — it is delivered only through the gated content API
// (app/api/framework/content/route.ts) to clients that pass the browser
// checks. Source of truth for the long-form version: docs/trading-framework.md.

export type TitledItem = { title: string; body: string };
export type DiagramNode = { lines: [string, string]; tone?: "pos" | "neg" };

export type FrameworkContent = {
  kicker: string;
  title: string;
  intro: string[];
  questions: { question: string; answer: string }[];
  plainLoop: { verb: string; stage: string; body: string }[];
  pipelineDiagram: DiagramNode[];
  pipeline: TitledItem[];
  principles: TitledItem[];
  layersHeading: string;
  layersIntro: string;
  layers: { name: string; body: string }[];
  decisionCoreIntro: string;
  decisionCore: TitledItem[];
  caseFileIntro: string;
  caseFile: { name: string; body: string }[];
  authorityIntro: string;
  authority: string[];
  flywheelNodes: DiagramNode[];
  flywheelCenter: [string, string];
  learningIntro: string;
  learningLanes: TitledItem[];
  outcomeIntro: string;
  outcomeLenses: TitledItem[];
  autonomyIntro: string;
  autonomy: TitledItem[];
  resilienceIntro: string;
  resilience: TitledItem[];
  invariantsIntro: string;
  invariants: string[];
  limitsIntro: string;
  limits: TitledItem[];
  disclosures: string[];
  humanOnlyNote: string;
};

import {
  FRAMEWORK_SIZING_INVARIANT,
  FRAMEWORK_VERDICT_INVARIANT,
  HOW_IT_WORKS_AUTHORITY_ITEMS
} from "@/lib/guardrail-copy";

export const FRAMEWORK_CONTENT: FrameworkContent = {
  kicker: "Trading Framework",
  title: "How Market Data Becomes an Accountable Trading Decision",
  intro: [
    "Socratic Trade is organized as a dialectic: one model argues for a trade, a second model argues against it, and deterministic code sizes every opening by default — with an optional, logged Socratic override when you enable it.  The name is the method: every position must survive questioning before it exists, and every outcome is examined afterward so the framework itself improves.",
    "This page describes the framework, not any particular account: the pipeline every strategy run flows through, the safety architecture around it, and the learning loop that closes it."
  ],
  questions: [
    {
      question: "What did the system believe?",
      answer:
        "The thesis: a plain-language claim with an expected edge, a time horizon, a catalyst, and the level that would invalidate it.  The proposing model supplies the claim and its invalidation levels, and the decision record carries them forward from there."
    },
    {
      question: "Why did it believe it?",
      answer:
        "The evidence bundle assembled before the proposal — market data, fundamentals, technicals, filings, alternative-data signals, and prior outcomes — together with the realized statistics the sizing math uses.  Every field records which source supplied it, so the reasoning can be checked against the same inputs the models saw."
    },
    {
      question: "What did it remember?",
      answer:
        "Episodic memory of closed trades, retrieved at decision time as advisory analogs, with opposite-outcome cases labeled as counterexamples rather than filtered out.  The account's own scorecards and the counterfactuals tracked for skipped candidates add to what it can recall."
    },
    {
      question: "What could prove it wrong?",
      answer:
        "The invalidation levels attached to the thesis, the counterargument the Red Team puts in front of it, and the policy conditions that would have blocked the trade.  Dissent is down-only: it can shrink or stop a position, never enlarge one."
    },
    {
      question: "What did it do?",
      answer:
        "The action the pipeline took and the reason it was allowed — proposed, placed, filled, rejected, expired, or blocked — with the authority source and the policy checks that applied.  Under delegated authority the record still names the mandate that permitted the action."
    },
    {
      question: "What happened?",
      answer:
        "The outcome, where it can be resolved: fill state, realized or unrealized result, and the gap between expected and actual movement.  Outcomes that cannot be resolved stay in the denominator and are disclosed rather than quietly dropped."
    },
    {
      question: "How should the framework improve?",
      answer:
        "A proposed change to the prompt, retrieval, risk, sizing, universe, or rules, with an accept, reject, or rewrite status.  Changes have to earn their way through statistical gates, and every applied mutation is clamped, ledgered, and revertible."
    }
  ],
  plainLoop: [
    {
      verb: "Observe",
      stage: "1 · Observe",
      body: "Read the market regime, the account state, open positions, candidate scans, news, fundamentals, technicals, and prior outcome memory."
    },
    {
      verb: "Argue",
      stage: "2 · Assemble Evidence / 3 · Green Team Proposes / 5 · Red Team Challenges",
      body: "Build a thesis, retrieve the prior cases that resemble it, weigh the evidence that supports or weakens it, and put the counterargument in front of a second model."
    },
    {
      verb: "Decide",
      stage: "4 · Code Sizes the Trade / 6 · Policy Gate Decides",
      body: "Choose buy, sell, hold, wait, resize, exit, or reject.  The decision records the authority source, the policy checks, and the exposure impact."
    },
    {
      verb: "Act",
      stage: "7 · Broker executes",
      body: "When the authority you delegated allows it, the order is placed.  Proposed, placed, filled, rejected, expired, and blocked are recorded as separate states."
    },
    {
      verb: "Explain",
      stage: "The Decision Record",
      body: "The decision note says what it believed, why it believed it, what memory contributed, what could prove it wrong, and what it did."
    },
    {
      verb: "Learn",
      stage: "8 · Account and Learn",
      body: "Closed and counterfactual outcomes, where they can be resolved, can inform scorecards and proposed framework changes that go to review rather than straight into the next run."
    }
  ],
  pipelineDiagram: [
    { lines: ["Observe", "the market"] },
    { lines: ["Assemble", "evidence"] },
    { lines: ["Green Team", "proposes"], tone: "pos" },
    { lines: ["Code sizes", "the trade"] },
    { lines: ["Red Team", "challenges"], tone: "neg" },
    { lines: ["Policy gate", "decides"] },
    { lines: ["Broker", "executes"] },
    { lines: ["Account", "and learn"] }
  ],
  pipeline: [
    {
      title: "1 · Observe",
      body: "Scan a configured symbol universe from a broad delayed screener plus dynamic index membership.  Rank every name on eight factors — liquidity, momentum, value, quality, volatility, sentiment, positioning, diversification — then enrich top candidates through a cascading multi-provider data layer where every field records which source supplied it.  Real data or an honest blank; the framework never fabricates a number."
    },
    {
      title: "2 · Assemble Evidence",
      body: "Build a structured evidence bundle: macro data with a deterministic market-regime label, market internals, technicals, SEC-filing retrieval, congressional and insider signals, episodic memory of similar past decisions (counterexamples included, not curated out), the account's own realized scorecards, and tax context.  Untrusted text is fenced as data, never commands."
    },
    {
      title: "3 · Green Team Proposes",
      body: "An explicitly chosen proposer model returns schema-constrained trade proposals: symbol, side, a thesis tag from a fixed playbook, a confidence score, rationale, and invalidation levels.  Proposing nothing is an explicitly legitimate outcome — inaction is measured, not hidden."
    },
    {
      title: "4 · Code Sizes the Trade",
      body: "Deterministic code — not the model — sizes every opening from realized per-thesis statistics: shrunk win rates, capped and calibrated conviction, reduce-only Kelly, volatility and portfolio-heat tapers.  Thin evidence pins size to an exploratory floor; proven losers get zero.  A logged Socratic override may request a larger deployment when you enable that mode."
    },
    {
      title: "5 · Red Team Challenges",
      body: "A second, separately chosen model adversarially reviews every risk-adding opening at its final size, fact-checking the rationale against the same evidence the proposer saw.  Its verdict is down-only: approve, approve at half size, or reject.  If the reviewer cannot run for any reason, the trade fails closed to human approval.  Exits are structurally exempt — dissent can never block de-risking."
    },
    {
      title: "6 · Policy Gate Decides",
      body: "A deterministic policy engine evaluates the sized, reviewed proposal against configured rules: exposure, notional, and concentration caps; order-type, drift, and staleness checks; wash-sale and short-sale handling.  Only physical, broker, regulatory, and accounting impossibilities are hard blocks — everything else is an adjustable preference with a logged override path."
    },
    {
      title: "7 · Broker executes",
      body: "Approved orders route through one guarded choke point into a broker-agnostic gateway.  Placement is crash-safe and idempotent: intent is persisted before the broker call, uncertain outcomes reconcile against broker truth, and protective stops rest at the broker so they survive app downtime.  Paper vs. live is purely a property of the connected account — there is no simulation mode."
    },
    {
      title: "8 · Account and Learn",
      body: "Fills are event-sourced and replayed into P&L, scorecards, and confidence calibration.  Skipped and vetoed candidates become counterfactuals, closed trades feed episodic memory and post-mortems, and a statistically gated tuner may adjust factor weights — every learning mutation ledgered, revertible, and audited."
    }
  ],
  principles: [
    {
      title: "The Model Proposes, Code Disposes",
      body: "Models generate ideas and critiques.  Deterministic code owns sizing, gating, placement, and accounting — and a regression test proves advisory context can never reach the sizing math."
    },
    {
      title: "Fail-Open for Data, Fail-Closed for Money",
      body: "A missing quote degrades to a dash and the scan continues.  A missing reviewer, credential, or model halts auto-execution and routes to a human.  A wrong-but-plausible decision is worse than no decision."
    },
    {
      title: "Advisory Guardrails, Hard Boundaries",
      body: "Risk rules advise, log, and escalate; they are adjustable preferences, not cages.  The hard blocks are reserved for account isolation and physical, broker, regulatory, or accounting impossibility."
    },
    {
      title: "Never Fabricate",
      body: "No synthetic data tier exists.  Benchmarks return nothing rather than a guess, statistics are sample-gated, and outcomes that cannot be resolved stay in denominators with an explicit disclosure."
    },
    {
      title: "Dissent Is Structural",
      body: "Every risk-adding opening faces an adversarial review with evidence parity, and verdicts are down-only — dissent can shrink or block risk, never enlarge it.  The reviewer's own value-add is measured with counterfactuals."
    },
    {
      title: "Everything Leaves a Receipt",
      body: "Every decision persists a case file with its evidence, verdicts, and overrides; every model call writes a usage-ledger row; every learning mutation lands in an append-only ledger with a single revert path."
    }
  ],
  layersHeading: "The Layered Architecture",
  layersIntro:
    "Each layer consumes the one above it and reports into the learning loop at the bottom, which feeds evidence back to the top.  Failures degrade within a layer; they do not cascade.",
  layers: [
    {
      name: "Market Observation",
      body: "Universe assembly, factor ranking, cascading enrichment with per-field provenance, macro/regime classification, technicals, market internals, and a computed trading calendar."
    },
    {
      name: "Evidence Assembly",
      body: "Filing retrieval, alternative-data signals, episodic memory with counterexamples, realized scorecards, and tax context — fenced behind a data-not-command boundary."
    },
    {
      name: "Decision Core",
      body: "Green Team proposes, deterministic code sizes, Red Team challenges, and a structured override path lets the agent argue past preference gates — on the record."
    },
    {
      name: "Policy Gate",
      body: "One deterministic pre-trade gate over every proposal, with a closed list of hard blocks, escalation cards for self-healing failures, and exits that can never be trapped."
    },
    {
      name: "Execution",
      body: "A broker-agnostic gateway behind a single guarded choke point: idempotent placement, reconciliation against broker truth, and broker-held protective stops."
    },
    {
      name: "Accounting",
      body: "Event-sourced fills replayed into P&L and scorecards; paper fills cost-adjusted so learned edges survive live slippage; honest cash-flow-aware benchmarking."
    },
    {
      name: "Learning",
      body: "Post-mortems, counterfactuals, episodic memory, crossover safety gates, and statistically validated tuning — ledgered, clamped, revertible, and audited daily."
    }
  ],
  decisionCoreIntro:
    "The decision core is where the dialectic happens.  Its roles are deliberately separated and its authority deliberately asymmetric.",
  decisionCore: [
    {
      title: "Green Team (The Proposer)",
      body: "An explicitly chosen model receives the full evidence bundle and returns structured proposals under a strict schema.  It runs deterministically, with a failover chain for transient provider failures.  There are no default models — an unchosen seat fails closed with an actionable error, never a silent substitute."
    },
    {
      title: "Deterministic Sizing",
      body: "Size comes from realized statistics, not model enthusiasm.  Confidence can shrink a position freely but can only raise it past a cap when the thesis's own realized record corroborates it.  Calibration remaps persistent overconfidence downward only."
    },
    {
      title: "Red Team (The Adversary)",
      body: "A separately chosen model reviews every risk-adding opening at its final size — no conviction threshold, no exceptions.  It fact-checks the rationale against the same evidence the proposer saw and critiques the exact sized order in the current regime.  Down-only verdicts; any failure mode routes to a human, loudly."
    },
    {
      title: "The Socratic Override",
      body: "The dialectic runs both ways: the agent may attach a structured override thesis to argue past preference gates — including a Red Team veto — stating what it believes, what conflicts it acknowledges, and what would prove it wrong.  It resolves once, under an owner-configured mode, never bypasses hard gates, and every use is tagged and audited."
    }
  ],
  caseFileIntro:
    "A decision record can carry the thesis, the available evidence, the account authority, the action status, and the outcome.  The fields below are the ones the interface is designed to show; coverage depends on the source data and on how far the workflow ran.",
  caseFile: [
    {
      name: "Thesis",
      body: "Plain-language claim, expected edge, time horizon, catalyst, invalidation trigger, and linked positions."
    },
    {
      name: "Evidence",
      body: "Source-backed bullets split across market data, fundamentals, technicals, news, portfolio context, and freshness."
    },
    {
      name: "Memory Influence",
      body: "Prior cases from retrieval, whether they reinforced or weakened the decision, and how they changed sizing or action."
    },
    {
      name: "Counterargument",
      body: "The best reason the thesis could be wrong, the competing action, and the condition that would invalidate the current view."
    },
    {
      name: "Action Taken",
      body: "Final action, status, order details when applicable, and the authority or blocker that allowed or prevented it."
    },
    {
      name: "Outcome",
      body: "Fill state, realized or unrealized result, actual versus expected movement, and what the model got right or wrong."
    },
    {
      name: "Framework Improvement",
      body: "A proposed change to prompt, retrieval, risk, sizing, universe, or rules, with accept, reject, or rewrite status."
    }
  ],
  authorityIntro:
    "The interface separates confidence from permission: a strong thesis is not itself authority, and delegated scope is.  When the framework reads a selloff as a buying opportunity rather than a reason to retreat, the record has to say which mandate allowed it, what evidence justified it, and what condition would have stopped it.",
  authority: [...HOW_IT_WORKS_AUTHORITY_ITEMS],
  flywheelNodes: [
    { lines: ["Decisions", "and fills"] },
    { lines: ["Event-sourced", "accounting"] },
    { lines: ["Scorecards and", "calibration"] },
    { lines: ["Counterfactuals", "and memory"] },
    { lines: ["Validated", "tuning"] },
    { lines: ["Better", "evidence"], tone: "pos" }
  ],
  flywheelCenter: ["Ledgered, audited,", "revertible"],
  learningIntro:
    "Learning is a visible trail, not a vague claim.  Five lanes run in parallel — all advisory by default, with exactly two tightly gated surfaces that can change behavior.",
  learningLanes: [
    {
      title: "Post-Mortems",
      body: "Closed trades are reviewed with excursion timing — did winners get cut early, did losers get held through drawdowns? — and a bounded reflection feeds the next run's prompt."
    },
    {
      title: "Counterfactuals",
      body: "Every scored-but-skipped candidate and every vetoed proposal is tracked against what actually happened afterward, over trading-day horizons, against real prices only.  Unresolvable rows stay in denominators, disclosed.  The adversary's vetoes are scored the same way."
    },
    {
      title: "Episodic Memory",
      body: "Closed trades are embedded — entry situation plus realized outcome — and recalled at decision time as advisory analogs, with opposite-outcome cases labeled as counterexamples rather than filtered out, and no lookahead."
    },
    {
      title: "Crossover Safety",
      body: "Learned lessons pass a fail-closed risk classifier before they can influence anything.  Facts flow as advisory context; anything touching risk needs human confirmation; conversational chat can never even queue a risk-tier lesson; and nothing learned can ever reach the sizing math."
    },
    {
      title: "Validated Tuning",
      body: "Factor-weight changes must earn their way through an information-coefficient backtest with walk-forward out-of-sample validation.  Autonomous application is off by default, clamped per step, scoped to scoring weights only, and every mutation lands in an append-only ledger with one revert path.  A daily review board audits the lessons themselves for corruption by system defects."
    }
  ],
  outcomeIntro:
    "Outcome review connects recorded theses and actions with the outcomes that can be resolved, and with proposed framework changes.  These records can help you assess a workflow; they do not establish that a change will improve future trading results.  What each lens can show depends on your sources, on how many cycles have closed, and on what the workflow recorded.",
  outcomeLenses: [
    {
      title: "Thesis Scorecards",
      body: "Which thesis types worked, failed, or needed a different holding period."
    },
    {
      title: "Regime Scorecards",
      body: "Whether the same idea behaved differently in calm, stressed, bearish, bullish, or flash-crash conditions."
    },
    {
      title: "Evidence Quality",
      body: "Compare recorded sources, retrieved context, and contradictions alongside the available outcomes."
    },
    {
      title: "Mistake Review",
      body: "False positives, missed opportunities, late exits, overruled wins, overruled losses, and repeated failure modes."
    }
  ],
  autonomyIntro:
    "Autonomy is opt-in per account, explicit about authority, and engineered so that concurrency, crashes, and restarts fail toward safety.",
  autonomy: [
    {
      title: "Four Entry Points, One Pipeline",
      body: "Scheduled cadence runs, event triggers (filings, regime flips, technical alerts — deduplicated and coalesced so a storm produces one run), manual run-once, and a chat assistant whose tools are read-only or draft-producing.  All converge on the same run pipeline and proposal rail; a chat draft can only be promoted into the normal approval flow, never placed directly."
    },
    {
      title: "Authority Is Explicit",
      body: "Propose mode turns every proposal into a human approval card.  Decide mode auto-executes — except for the fail-closed set: an unavailable reviewer, an unplaceable half-size verdict, or degraded reasoning quality all route to a human.  Manual runs force propose mode, and cap breaches auto-demote authority back to ask-first."
    },
    {
      title: "One Leader, One Run Per Account",
      body: "Lease-based leader election ensures one scheduler per database; per-account single-flight locks ensure one run per broker account; and fencing checkpoints re-prove ownership before every irreversible step, so a run that loses its lease stops before placing another order."
    },
    {
      title: "Safety Maintenance Never Starves",
      body: "Fill reconciliation, protective-stop monitoring, stale-order remediation, and proposal expiry run on every tick regardless of budgets or autonomy state.  Spend ceilings only ever skip model work.  And autonomy never resumes unattended after a restart — that requires an explicit opt-in."
    }
  ],
  resilienceIntro:
    "Operational resilience is the part of the system that keeps a partial failure from turning into a bad trade.  It covers the health of external dependencies, the truthfulness of the alerts you rely on, and the budgets that limit model spend without ever limiting safety work.",
  resilience: [
    {
      title: "Per-Credential Circuit Breaking",
      body: "Health, trips, alerts, and cooldowns are scoped to a service-and-key-source lane, so one dead key never takes down a sibling lane.  A tripped lane is skipped before the request goes out, which keeps a failure from reinforcing its own streak."
    },
    {
      title: "Monitoring Cannot Become The Outage",
      body: "The observability code swallows its own errors.  Monitoring is never allowed to be the thing that fails while the thing it watches keeps running."
    },
    {
      title: "Truthful Notifications",
      body: "Dispatch across push, webhook, email, and SMS records a message as sent only when a channel actually delivered it.  An alert clears only on proof of resolution, and a broker-uncertain alert clears only when the broker's own state confirms what happened."
    },
    {
      title: "Layered Model Budgeting",
      body: "Per-user daily ceilings, a compare-and-swap reservation per run that closes concurrent-run races, and an operator monthly ceiling are enforced at a single choke point.  That choke point can only skip model work, never safety maintenance, and every call writes a usage-ledger row with cache-aware cost accounting."
    }
  ],
  invariantsIntro: "Invariants the framework enforces in code:",
  invariants: [
    "No connected broker account means no orders — there is no simulation fallback.",
    "Every risk-adding opening is adversarially reviewed or held for a human; reviewer failure fails closed.",
    FRAMEWORK_VERDICT_INVARIANT,
    FRAMEWORK_SIZING_INVARIANT,
    "Exits are never trapped — not by universe rules, caps, budgets, staleness, or adversary outages.",
    "Nothing is fabricated: missing data renders blank, statistics are sample-gated, unresolved outcomes are disclosed.",
    "Placement is intent-first and idempotent; uncertain broker outcomes are reconciled, never guessed.",
    "Coordination failures fail closed: no proven lease, no money-path side effects.",
    "Every decision, verdict, override, and learning mutation leaves a durable, attributable receipt.",
    "Learning mutations are clamped, statistically gated, ledgered, and revertible."
  ],
  limitsIntro:
    "Kept per the framework's own rule: honest weaknesses stay listed until fixed, and fixed items move to a fixed list rather than being deleted.",
  limits: [
    {
      title: "The Factor Weights Started as Educated Guesses",
      body: "The validation machinery exists to earn changes, but early samples are small and statistical shrinkage dominates."
    },
    {
      title: "Cold Start Is Real",
      body: "Scorecards, calibration, and memory all need closed trades to say anything; a new account trades on floors and caps, not evidence."
    },
    {
      title: "Model Judgment Is the Point — and the Risk",
      body: "Structured outputs, evidence parity, adversarial review, and deterministic gates bound the blast radius, but a plausible-sounding thesis can still be wrong in ways no gate catches."
    },
    {
      title: "Free-Tier Data Has Gaps",
      body: "The cascade degrades honestly, but degraded is still degraded: thin fundamentals on small names, delayed base quotes, provider quotas on enrichment depth."
    },
    {
      title: "Counterfactuals Measure Price, Not Fills",
      body: "Skipped-candidate returns ignore the execution costs and liquidity constraints a real fill would have faced."
    }
  ],
  disclosures: [
    "Socratic Trade is software for market research, autonomous reasoning, and trade execution when connected to accounts you configure.  It is not investment advice, a broker-dealer, or a registered investment adviser.",
    "Trading and investing involve substantial risk of loss.  Simulated, hypothetical, or historical performance has inherent limitations and does not guarantee future results.  Nothing here is a recommendation to buy or sell any security.",
    "You are responsible for your own investment decisions and for the authority you grant to any connected trading system."
  ],
  humanOnlyNote:
    "This page is provided for human readers in a browser.  Automated access, scraping, text-and-data mining, and use of its content for AI training are not authorized."
};
