import {
  dailyExecutionStats,
  getActiveStrategyProfile,
  getAutoResumeOnBoot,
  getPolicy,
  peekPolicy,
  getProposalsByIds,
  getStrategyPrompt,
  latestAuditByKind,
  listAudit,
  listAuditByKind,
  listNotificationEvents,
  sweepAutoAcknowledgeNotifications,
  listPendingProposals,
  listRecentProposals,
  listStrategyProfiles,
  listStrategyRuns,
  listFillEvents,
  listConnectedAccounts,
  getActiveConnectedAccount,
  filterFullStopPlansByLiveBasis,
  getStopPlans,
  userHasAnyLlmCredential,
  listSocraticDecisionCases,
  listSocraticFrameworkProposals
} from "./db";
import { buildAuditFeed, buildSymbolMetaBySymbol, buildUnifiedFeed } from "./dashboard-feed";
import type { StrategyDecisionLike } from "./dashboard-feed";
import { currentMarketSession } from "./market-hours";
import { normalizeSymbol } from "./money";
import { getPerformanceSummary, getRedTeamEfficacy, getRegimeScorecard, getThesisScorecard, returnSinceProposalPct } from "./performance";
import { computeSpyBenchmark } from "./benchmark";
import { getTaxSummary } from "./tax";
import { getBrokerGateway } from "./broker";
import { getRobinhoodMcpHealth, type RobinhoodMcpHealth } from "./robinhood";
import { getStoredMcpOAuthTokens } from "./mcp-oauth";
import { deriveExecutionState, fillSourceForExecutionMode } from "./execution-mode";
import { getSchedulerState } from "./scheduler";
import { getCongressDataset, getInsiderDataset, getWebSourcesStatus, type CongressTrade } from "./web-sources";
import { readCongressScoreVerdict } from "./congress-score-gate";
import { fetchMacroData, determineMarketRegime, type MacroData } from "./macro";
import { deriveMacroMetrics } from "./macro-metrics";
import { computeMarketInternals } from "./market-internals";
import { getMarketSignals, type MarketSignals } from "./market-signals";
import { fetchMassiveNews } from "./market-signals/massive";
import { fetchMacroHistory } from "./macro-history";
import type { PrefetchedFills } from "./performance";
import type { BrokerageAccount, BrokerQuote, ConnectedAccount, EquityOrder, EquityPosition, OptionPosition, FillEvent, MarketQuote, MarketScan, NotificationEvent, NotificationEventType, Portfolio, TradeProposal, TradingPolicy } from "./types";
import { isAdminEmail } from "./auth/admin";
import { messageFromUnknownError, recordRecoverableIssue } from "./recoverable-issue";
import { checkAndDispatchOptionAlerts } from "./notifications";

const PROPOSAL_PERFORMANCE_MIN_AGE_MS = 15 * 60_000;
const RED_TEAM_EFFICACY_AUDIT_LIMIT = 500;

// Same "no data" shape fetchMacroData's own internal failure path returns (BLANK_MACRO in
// macro.ts, not exported) — used only as the deadline fallback below, since fetchMacroData already
// never rejects on its own.
const BLANK_MACRO_FALLBACK: MacroData = {
  fedFundsRate: "",
  dgs3moTreasury: "",
  dgs2Treasury: "",
  dgs10Treasury: "",
  inflationExpectation10y: "",
  cpiInflation: "",
  corePCE: "",
  realGDPGrowth: "",
  unemploymentRate: "",
  initialClaims: "",
  m2MoneySupply: "",
  m2GrowthYoY: "",
  hyCreditSpread: "",
  usdIndex: "",
  wtiOil: "",
  housingStarts: "",
  consumerSentiment: "",
  vix: "",
  vix3m: "",
  asOf: "unavailable",
  fredSourced: false
};

/**
 * Races an upstream promise against a deadline so a single hanging fetch (e.g. the undici
 * IPv6-blackhole failure mode — see docs/rollouts/2026-07-06-api-health-timeouts.md) can never block
 * the whole dashboard snapshot indefinitely. Does NOT abort the underlying promise — it keeps
 * running in the background and its eventual resolution/rejection is simply ignored once the
 * deadline has already produced a fallback. Existing `.catch(...)` fallbacks in this file still
 * handle real rejections; this only guards against a promise that never settles at all.
 */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  fallback: () => T,
  label: string,
  timedOutSections?: string[]
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[dashboard] ${label} timed out after ${ms}ms — serving degraded snapshot section`);
      timedOutSections?.push(label);
      resolve(fallback());
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export interface AccountReadiness {
  ok: boolean;
  reason?: string;
  detail: string;
  accountNumber?: string;
  connectedAccountId?: string;
  broker?: TradingPolicy["activeBroker"] | ConnectedAccount["broker"];
}

/**
 * Derive agentic-allowed for a STORED connected account, used as a fallback when the live broker
 * enumeration is unavailable. Mirrors the live gateways: Robinhood defaults agentic-allowed only for a
 * standard brokerage account (not IRA/Roth); Alpaca and the local Test gateway report agentic-allowed
 * for all of their accounts. Exported for unit testing.
 */
export function connectedAccountAgenticFallback(account: {
  broker: string;
  capabilities?: { accountType?: string };
}): boolean {
  if (account.broker === "robinhood") {
    return (account.capabilities?.accountType ?? "brokerage") === "brokerage";
  }
  return true; // alpaca / alpaca-mcp / test gateways report agentic-allowed for all their accounts
}

function brokerDisplayName(broker: AccountReadiness["broker"] | undefined): string {
  switch (broker) {
    case "alpaca":
    case "alpaca-mcp":
      return "Alpaca";
    case "robinhood":
      return "Robinhood";
    case "test":
      return "Test";
    case "tradier":
      return "Tradier";
    default:
      return "broker";
  }
}

function robinhoodMcpHealthIssue(health: RobinhoodMcpHealth | undefined): string | undefined {
  if (!health) return undefined;
  if (health.ok && health.configured && health.authenticated) return undefined;
  return health.error ?? health.warning ?? "Robinhood OAuth is not connected.";
}

export function accountReadinessForSnapshot(input: {
  policy: TradingPolicy;
  activeAccount?: ConnectedAccount;
  liveAccounts: BrokerageAccount[];
  brokerAccountReadError?: string;
  portfolioReadError?: string;
  robinhoodMcpHealth?: RobinhoodMcpHealth;
}): AccountReadiness {
  const { policy, activeAccount } = input;
  const accountNumber = policy.accountNumber ?? activeAccount?.accountNumber;
  const broker = activeAccount?.broker ?? policy.activeBroker;
  const brokerName = brokerDisplayName(broker);

  if (!accountNumber) {
    return {
      ok: false,
      reason: "Select an account before enabling autonomy.",
      detail: "No account is selected.",
      connectedAccountId: policy.connectedAccountId,
      broker
    };
  }

  if (policy.connectedAccountId && !activeAccount) {
    return {
      ok: false,
      reason: "Open Accounts and choose a working account before enabling autonomy.",
      detail: `Selected connected account ${policy.connectedAccountId} was not found.`,
      accountNumber,
      connectedAccountId: policy.connectedAccountId,
      broker
    };
  }

  const robinhoodIssue = broker === "robinhood" ? robinhoodMcpHealthIssue(input.robinhoodMcpHealth) : undefined;
  if (robinhoodIssue) {
    return {
      ok: false,
      reason: "Reconnect Robinhood OAuth before enabling autonomy.",
      detail: robinhoodIssue,
      accountNumber,
      connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
      broker
    };
  }

  if (input.brokerAccountReadError) {
    return {
      ok: false,
      reason: `${brokerName} account check failed. Open Accounts and reconnect or fix credentials.`,
      detail: input.brokerAccountReadError,
      accountNumber,
      connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
      broker
    };
  }

  const liveAccount = input.liveAccounts.find((account) => account.accountNumber === accountNumber);
  if (!liveAccount) {
    return {
      ok: false,
      reason: `Selected ${brokerName} account is not available from the broker.`,
      detail: `The selected account ${accountNumber} was not returned by ${brokerName}.`,
      accountNumber,
      connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
      broker
    };
  }

  if (!liveAccount.agenticAllowed) {
    return {
      ok: false,
      reason: `Selected ${brokerName} account is not approved for agentic execution.`,
      detail: `${brokerName} returned account ${accountNumber}, but marked it not agentic-allowed.`,
      accountNumber,
      connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
      broker
    };
  }

  if (input.portfolioReadError) {
    return {
      ok: false,
      reason: `${brokerName} account data check failed. Open Accounts and reconnect or fix credentials.`,
      detail: input.portfolioReadError,
      accountNumber,
      connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
      broker
    };
  }

  return {
    ok: true,
    detail: `Selected ${brokerName} account ${accountNumber} is available for execution.`,
    accountNumber,
    connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
    broker
  };
}

export interface CurrentUserDisplay {
  email?: string;
  name?: string;
  imageUrl?: string;
  loginProvider?: string;
}

export async function getDashboardSnapshot(userId: string = "local", currentUser?: string | CurrentUserDisplay) {
  const snapshotStartedAt = Date.now();
  const timedOutSections: string[] = [];
  const currentUserDisplay: CurrentUserDisplay =
    typeof currentUser === "string" ? { email: currentUser } : currentUser ?? {};
  const policy = getPolicy(userId);
  const activeAccount = getActiveConnectedAccount(userId);
  const connectedAccounts = listConnectedAccounts(userId);
  // Read-only projection: generating a dashboard snapshot must not seed
  // account_strategy_state. peekPolicy returns the same effective
  // systemState/strategyAuthority getPolicy would compute on first touch,
  // without persisting a row (getPolicy writes one for un-seeded accounts).
  const connectedAccountPolicies = Object.fromEntries(
    connectedAccounts.map((account) => {
      const pol = peekPolicy(userId, account.id);
      // runDuringExtendedHours rides along so the account-switcher's market-aware run-state chip
      // can honor each account's extended-hours setting — without it, an extended-hours account
      // would read "Paused · market closed" during pre/post sessions while genuinely running.
      return [
        account.id,
        {
          systemState: pol.systemState,
          strategyAuthority: pol.strategyAuthority,
          runDuringExtendedHours: pol.runDuringExtendedHours
        }
      ];
    })
  );
  const accountLabelById = Object.fromEntries(connectedAccounts.map((account) => [account.id, account.label || account.broker]));
  // An account is an account: with none connected there is no broker to call. Skip the gateway
  // entirely rather than falling back to any local/simulated broker — the snapshot still renders,
  // it just reports no accounts/portfolio, and accountReadinessForSnapshot reports "no account".
  const gateway = activeAccount ? getBrokerGateway(policy, userId) : undefined;

  // Independent upstream groups now run fully in parallel instead of stacking sequentially (this
  // used to be ~46s worst-case: accounts 6s -> RH health 4s -> portfolio 8s -> quotes 6s ->
  // benchmark 4s -> macro 6s -> signals 4s -> history 4s -> news 4s, each awaited before the next
  // began). Two genuine data dependencies remain sequential and are kept as one chain below: (1)
  // the broker chain (accounts -> portfolio/positions/orders -> quotes), because accountNumber can
  // fall back to a discovered live account when policy.accountNumber is unset, and quotes need the
  // resolved positions; (2) the SPY benchmark, computed further down because it needs the
  // performance summary built from quotes. Everything else — Robinhood MCP health and the whole
  // macro board (macro/signals/history/news) — has no dependency on the broker chain or on each
  // other, so all of it is raced against the chain with one Promise.all.
  const brokerChainPromise: Promise<{
    accounts: BrokerageAccount[];
    liveAccounts: BrokerageAccount[];
    brokerAccountReadError?: string;
    options: OptionPosition[];
    accountNumber?: string;
    portfolio?: Portfolio;
    positions: EquityPosition[];
    orders: EquityOrder[];
    portfolioReadError?: string;
    currentPrices: Record<string, number>;
  }> = (async () => {
    let accounts: BrokerageAccount[] = [];
    let brokerAccountReadError: string | undefined;
    const handleAccountsReadFailure = (message: string) => {
      brokerAccountReadError = message;
      console.warn("Failed to fetch accounts:", message);
      recordRecoverableIssue({
        source: "broker",
        operation: "dashboard.getAccounts",
        severity: "error",
        message,
        fallback: "Using stored connected-account rows so configured accounts remain visible.",
        userId,
        connectedAccountId: policy.connectedAccountId,
        broker: policy.activeBroker,
        accountNumber: policy.accountNumber
      });
    };
    if (gateway) {
      try {
        accounts = await withDeadline(
          gateway.getAccounts(),
          6000,
          () => {
            handleAccountsReadFailure("Timed out waiting for gateway.getAccounts after 6000ms.");
            return [];
          },
          "gateway.getAccounts",
          timedOutSections
        );
      } catch (error) {
        handleAccountsReadFailure(messageFromUnknownError(error));
      }
    }
    // Resilience: a live getAccounts() that fails or returns empty (a transient broker/MCP enumeration
    // miss) must not make the configured account vanish from the snapshot — which made the readiness
    // badge false-warn "not available for agentic execution". Backfill any stored connected account the
    // live list didn't return, deriving agenticAllowed from the account type so the selected account
    // always resolves to a definitive status.
    const liveAccounts = accounts.slice();
    const liveAccountNumbers = new Set(liveAccounts.map((account) => account.accountNumber));
    let storedBackfillCount = 0;
    let selectedAccountWasBackfilled = false;
    for (const connected of connectedAccounts) {
      if (!connected.accountNumber || liveAccountNumbers.has(connected.accountNumber)) continue;
      storedBackfillCount += 1;
      if (connected.id === policy.connectedAccountId || connected.accountNumber === policy.accountNumber) {
        selectedAccountWasBackfilled = true;
      }
      accounts.push({
        accountNumber: connected.accountNumber,
        label: connected.label,
        agenticAllowed: connectedAccountAgenticFallback(connected),
        capabilities: connected.capabilities
      });
    }
    if (storedBackfillCount > 0 && (brokerAccountReadError || selectedAccountWasBackfilled)) {
      recordRecoverableIssue({
        source: "broker",
        operation: "dashboard.connectedAccountBackfill",
        message: brokerAccountReadError
          ? "Live broker account enumeration failed, so the dashboard used stored connected-account metadata."
          : "Live broker account enumeration did not include the selected account.",
        fallback: "Stored connected-account rows were added to the dashboard snapshot.",
        userId,
        connectedAccountId: policy.connectedAccountId,
        broker: policy.activeBroker,
        accountNumber: policy.accountNumber,
        details: { backfilledAccounts: storedBackfillCount, brokerAccountReadFailed: Boolean(brokerAccountReadError), selectedAccountWasBackfilled }
      });
    }

    const accountNumber = policy.accountNumber ?? accounts.find((account) => account.agenticAllowed)?.accountNumber;
    let portfolio: Portfolio | undefined;
    let positions: EquityPosition[] = [];
    let options: OptionPosition[] = [];
    let orders: EquityOrder[] = [];
    let portfolioReadError: string | undefined;
    const handlePortfolioReadFailure = (message: string) => {
      portfolioReadError = message;
      console.warn("Failed to fetch portfolio:", message);
      recordRecoverableIssue({
        source: "broker",
        operation: "dashboard.getPortfolioBundle",
        severity: "error",
        message,
        fallback: "Dashboard snapshot continues without live portfolio, positions, options, and orders.",
        userId,
        connectedAccountId: policy.connectedAccountId,
        broker: policy.activeBroker,
        accountNumber
      });
    };
    if (accountNumber && gateway) {
      try {
        [portfolio, positions, orders] = await withDeadline<[Portfolio | undefined, EquityPosition[], EquityOrder[]]>(
          Promise.all([
            gateway.getPortfolio(accountNumber),
            gateway.getEquityPositions(accountNumber),
            gateway.getEquityOrders(accountNumber)
          ]),
          8000,
          () => {
            handlePortfolioReadFailure("Timed out waiting for portfolio, positions, and orders after 8000ms.");
            return [undefined, [], []];
          },
          "portfolio/positions/orders",
          timedOutSections
        );
      } catch (error) {
        handlePortfolioReadFailure(messageFromUnknownError(error));
      }
      // Option positions are best-effort: a transient failure (notably an MCP
      // tool error) must not crash the whole dashboard bundle. Wrap the fetch in
      // the same withDeadline guard the portfolio/positions/orders legs use — the
      // try/catch only handles a REJECTION, so a HUNG options/MCP endpoint would
      // otherwise hang the whole snapshot forever (the catch never runs and the
      // dashboard never renders). Time out to an empty list like the other legs.
      if (gateway.getOptionPositions) {
        try {
          options = await withDeadline<OptionPosition[]>(
            gateway.getOptionPositions(accountNumber),
            8000,
            () => [],
            "gateway.getOptionPositions",
            timedOutSections
          );
        } catch (err) {
          console.warn("[Dashboard] options positions unavailable (non-fatal):", err);
        }
      }
      if (options.length > 0) {
        checkAndDispatchOptionAlerts(userId, policy.connectedAccountId || "", accountNumber, options, gateway).catch((err) =>
          console.warn("[OptionAlerts] failed:", err)
        );
      }
    }

    // Live current-price map (broker quotes for held symbols) so P&L is marked to the same prices
    // the broker reports. An account is an account: `portfolio`/`positions` are always the real
    // broker-reported values for the active account — there is no locally-projected alternative.
    let currentPrices: Record<string, number> = {};
    if (accountNumber && gateway && portfolio) {
      const priceSymbols = Array.from(new Set(positions.map((p) => normalizeSymbol(p.symbol))));
      const quotes: Record<string, BrokerQuote> = priceSymbols.length > 0
        ? await withDeadline(
            gateway.getEquityQuotes(accountNumber, priceSymbols),
            6000,
            () => ({}),
            "gateway.getEquityQuotes",
            timedOutSections
          )
        : {};
      currentPrices = Object.fromEntries(
        Object.values(quotes)
          .filter((quote) => typeof quote.price === "number" && quote.price > 0)
          .map((quote) => [normalizeSymbol(quote.symbol), quote.price as number] as const)
      );
      // Fall back to the live position's mark when a broker quote is missing.
      for (const position of positions) {
        const symbol = normalizeSymbol(position.symbol);
        if (!(symbol in currentPrices) && position.quantity > 0) currentPrices[symbol] = position.marketValue / position.quantity;
      }
    }

    return { accounts, liveAccounts, brokerAccountReadError, accountNumber, portfolio, positions, options, orders, portfolioReadError, currentPrices };
  })();

  const robinhoodMcpHealthPromise: Promise<RobinhoodMcpHealth | undefined> =
    (activeAccount?.broker ?? policy.activeBroker) === "robinhood"
      ? (() => {
          const robinhoodMcpHealthFallback = (error: unknown): RobinhoodMcpHealth => ({
            adapter: "mcp",
            ok: false,
            configured: false,
            authenticated: false,
            protocolVersion: "",
            transport: "http+sse",
            tools: [],
            checkedAt: new Date().toISOString(),
            error: messageFromUnknownError(error)
          });
          return withDeadline(
            getRobinhoodMcpHealth(userId).catch(robinhoodMcpHealthFallback),
            4000,
            () => robinhoodMcpHealthFallback(new Error("Timed out waiting for Robinhood MCP health check after 4000ms.")),
            "getRobinhoodMcpHealth",
            timedOutSections
          );
        })()
      : Promise.resolve(undefined);

  // Macro & market-regime board for the Macro tab (FRED macro + derived metrics + free
  // market-wide signals). Caches keep this cheap; failures degrade to defaults / omitted. None of
  // these four depend on the broker chain above, so they're kicked off here and raced alongside it.
  const macroDataPromise = withDeadline(fetchMacroData(userId), 6000, () => BLANK_MACRO_FALLBACK, "fetchMacroData", timedOutSections);
  const macroSignalsPromise = withDeadline(
    getMarketSignals(userId).catch((): MarketSignals => ({})),
    4000,
    (): MarketSignals => ({}),
    "getMarketSignals",
    timedOutSections
  );
  const macroHistoryPromise = withDeadline(
    fetchMacroHistory(Date.now(), userId).catch(() => ({} as Record<string, number[]>)),
    4000,
    () => ({} as Record<string, number[]>),
    "fetchMacroHistory",
    timedOutSections
  );
  const macroNewsPromise = withDeadline(fetchMassiveNews(8, userId).catch(() => []), 4000, () => [], "fetchMassiveNews", timedOutSections);

  const [brokerChain, robinhoodMcpHealth, macro, signals, history, news] = await Promise.all([
    brokerChainPromise,
    robinhoodMcpHealthPromise,
    macroDataPromise,
    macroSignalsPromise,
    macroHistoryPromise,
    macroNewsPromise
  ]);

  const {
    accounts,
    liveAccounts,
    brokerAccountReadError,
    accountNumber,
    portfolio,
    positions,
    options,
    orders,
    portfolioReadError,
    currentPrices
  } = brokerChain;

  const accountReadiness = accountReadinessForSnapshot({
    policy,
    activeAccount,
    liveAccounts,
    brokerAccountReadError,
    portfolioReadError,
    robinhoodMcpHealth
  });

  const dailyStats = accountNumber
    ? dailyExecutionStats(accountNumber, new Date(), userId)
    : { orderCount: 0, openingOrderCount: 0, notional: 0 };

  // Fetch live + paper fills ONCE per request (each is a 500-row SELECT + JSON.parse + FIFO replay)
  // and thread the parsed arrays into every downstream consumer — performance summary, scorecards,
  // tax, and the unified feed — instead of each re-issuing its own query.
  const liveFills: FillEvent[] = accountNumber ? listFillEvents(accountNumber, "live", 500, userId) : [];
  const paperFills: FillEvent[] = accountNumber ? listFillEvents(accountNumber, "paper", 500, userId) : [];
  const prefetchedFills: PrefetchedFills = { liveFills, paperFills };

  // currentPrices (broker quotes for held symbols, falling back to the live position's mark) was
  // already computed inside the broker chain above, in parallel with the independent groups.
  const displayPortfolio = portfolio;
  const displayPositions = positions;

  const pendingProposals = accountNumber ? listPendingProposals(accountNumber, userId) : [];
  const recentProposals = accountNumber ? listRecentProposals(accountNumber, 100, userId) : [];
  const performance = accountNumber ? getPerformanceSummary(accountNumber, currentPrices, userId, prefetchedFills) : undefined;
  const executionState = deriveExecutionState(policy, activeAccount);
  const scorecardSource = fillSourceForExecutionMode(executionState);
  // SPY-benchmark scoreboard for the active execution mode's equity curve. Best-effort: a SPY fetch
  // failure or sparse history simply leaves performance.benchmark undefined (UI shows "—").
  if (performance) {
    const curve = scorecardSource === "live" ? performance.liveEquityCurve : performance.paperEquityCurve;
    // Same-source fills let the benchmark infer deposits/withdrawals (cash delta minus trade
    // cash) so the account return line is time-weighted instead of counting transfers as P&L.
    const benchmarkFills = scorecardSource === "live" ? liveFills : paperFills;
    const benchmark = await withDeadline(
      computeSpyBenchmark(curve, userId, Date.now(), benchmarkFills).catch(() => null),
      4000,
      () => null,
      "computeSpyBenchmark",
      timedOutSections
    );
    if (benchmark) performance.benchmark = benchmark;
  }
  const thesisScorecard = accountNumber ? getThesisScorecard(accountNumber, scorecardSource, currentPrices, userId, prefetchedFills) : [];
  const regimeScorecard = accountNumber ? getRegimeScorecard(accountNumber, scorecardSource, currentPrices, userId, prefetchedFills) : [];
  const redTeamEfficacy = accountNumber ? getDashboardRedTeamEfficacy(userId, policy.connectedAccountId) : undefined;
  const tax = accountNumber
    ? getTaxSummary(accountNumber, scorecardSource, currentPrices, { ...policy.taxSettings, taxationType: activeAccount?.taxationType ?? policy.taxSettings?.taxationType }, new Date(), userId, prefetchedFills)
    : undefined;
  const profiles = listStrategyProfiles(userId);
  const activeProfile = getActiveStrategyProfile(userId);
  // Lazy auto-ack sweep: clears alerts whose condition is provably resolved (a pending_approval
  // whose proposal left "proposed", or a run_failed whose account has since run successfully)
  // before the snapshot's Attention count is computed. Cheap, bounded, idempotent — see
  // sweepAutoAcknowledgeNotifications in db-notifications.ts.
  sweepAutoAcknowledgeNotifications(userId);
  const notifications = listNotificationEvents(userId, 100);
  const latestRunAudit = policy.connectedAccountId
    ? latestAuditByKind("strategy_run", userId, policy.connectedAccountId)
    : latestAuditByKind("strategy_run", userId);
  const latestStrategyRun = latestRunAudit
    ? ({ ...(latestRunAudit.payload as StrategyDecisionLike), createdAt: latestRunAudit.createdAt } satisfies StrategyDecisionLike)
    : undefined;
  // Decision cases stay ACCOUNT-SCOPED: they drive the active account's Live thesis,
  // Autonomous action rows, and coach form (primaryDecision = decisions[0]), which must
  // reflect the account whose portfolio/capital is shown — not another account's latest trade.
  const socraticDecisions = listSocraticDecisionCases(userId, {
    limit: 50,
    ...(policy.connectedAccountId ? { connectedAccountId: policy.connectedAccountId } : {})
  });
  // Framework/"learning" proposals ARE read GLOBAL across the user's accounts: they are
  // generalizable strategy improvements (and the batched reviewer is cross-account), so the
  // review panel shows the whole backlog. Provenance is preserved via `connectedAccountId`.
  // This also matches the decision-detail page, which already fetched proposals user-wide.
  const socraticFrameworkProposals = listSocraticFrameworkProposals(userId, { limit: 25 });
  const audit = policy.connectedAccountId
    ? listAudit(100, userId, policy.connectedAccountId, true)
    : listAudit(100, userId);

  const advisoryAudits = audit
    .filter((e) =>
      [
        "deterministic_bear_veto",
        "red_team_veto_override_requested",
        "red_team_veto_overridden",
        "prompt_injection_suspected",
        "evidence_age_anomaly"
      ].includes(e.kind)
    )
    .map((e) => ({
      id: e.id,
      createdAt: e.createdAt,
      type: e.kind as NotificationEventType,
      title: e.kind,
      status: "sent" as const,
      payload: e.payload,
      connectedAccountId: e.connectedAccountId
    } satisfies NotificationEvent));

  const combinedNotifications = [...notifications, ...advisoryAudits]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 100);

  // Unified fills for the feed: merge the pre-fetched live + paper arrays (oldest-first, capped at
  // 500) instead of re-issuing the unfiltered listFillEvents query the feed builder used to trigger.
  const unifiedFills: FillEvent[] = accountNumber
    ? [...liveFills, ...paperFills].sort((a, b) => a.filledAt.localeCompare(b.filledAt)).slice(0, 500)
    : [];

  // Batch every proposal point-query the audit/unified-feed builders would otherwise issue one-by-one:
  // collect all distinct proposalIds referenced by audit rows, fills, and notifications, run ONE
  // `WHERE id IN (...)` query, and back a Map-keyed closure with it (with a memoized single-row
  // fallback for any id not pre-collected, so output is identical to the old per-row getProposal).
  const referencedProposalIds = new Set<string>();
  const addProposalId = (value: unknown) => {
    if (typeof value === "string" && value) referencedProposalIds.add(value);
  };
  const asRec = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  for (const event of audit) {
    const payload = asRec(event.payload);
    const nested = asRec(payload.payload);
    addProposalId(payload.proposalId);
    addProposalId(nested.proposalId);
    addProposalId(asRec(nested.proposal).id);
    addProposalId(asRec(nested.proposal).proposalId);
    addProposalId(asRec(nested.fill).proposalId);
  }
  for (const fill of unifiedFills) addProposalId(fill.proposalId);
  for (const notification of combinedNotifications) {
    const payload = asRec(notification.payload);
    addProposalId(payload.proposalId);
    addProposalId(asRec(payload.fill).proposalId);
    addProposalId(asRec(payload.proposal).id);
    addProposalId(asRec(payload.proposal).proposalId);
  }
  const proposalsById = getProposalsByIds([...referencedProposalIds], userId);
  const proposalFallbackCache = new Map<string, { proposal: TradeProposal } | undefined>();
  const getProposalById = (proposalId: string): { proposal: TradeProposal } | undefined => {
    const batched = proposalsById.get(proposalId);
    if (batched) return { proposal: batched.proposal };
    if (proposalFallbackCache.has(proposalId)) return proposalFallbackCache.get(proposalId);
    const single = getProposalsByIds([proposalId], userId).get(proposalId);
    const resolved = single ? { proposal: single.proposal } : undefined;
    proposalFallbackCache.set(proposalId, resolved);
    return resolved;
  };

  const symbolMetaBySymbol = buildSymbolMetaBySymbol({
    positions: displayPositions,
    orders,
    pendingProposals,
    latestStrategyRun
  });
  // Per-position stop PLANS (LLM-chosen stop TYPE, persisted at fill time) — surfaced in the
  // Positions table and the stop-flow diagram so a plan is never a hidden override. Best-effort:
  // a lookup failure just means the UI falls back to the account's own precedence for every symbol.
  const stopPlanBySymbol = (() => {
    // The RESOLVED account number (from brokerChain, same one positions/fills/proposals below all
    // use) — not policy.accountNumber directly. When the selected account is resolved from the
    // live/stored account list because policy.accountNumber is unset, using the policy field here
    // returned {} even though this snapshot is otherwise displaying the resolved account's data,
    // silently dropping plan-only protection/no-stop disclosures until the policy field catches up
    // (Codex review, PR #1371).
    if (!accountNumber) return {};
    try {
      // Filtered by live basis (avgCost match) — same reasoning as the strategy-run and synthetic-
      // monitor sides: a symbol closed and re-bought before cleanup swept the old row must not have
      // its stale plan label the new lot as "No stop (LLM choice)" or an active fixed/ATR/trailing
      // plan for a position that never made that choice (Codex review, PR #1371).
      return filterFullStopPlansByLiveBasis(getStopPlans(accountNumber, userId), displayPositions);
    } catch {
      return {};
    }
  })();
  const auditFeed = buildAuditFeed({
    audit,
    symbolMetaBySymbol,
    accountLabelById,
    getProposalById
  });

  // macro/signals/history/news were already fetched in parallel with the broker chain above.
  // Only compute internals from a full scan. Some historical/trimmed audit shapes only
  // preserve symbol metadata, which is useful for UI labels but not valuation math.
  const scanForInternals = fullMarketScan(latestStrategyRun?.marketScan);
  const marketEarningsYield = scanForInternals
    ? computeMarketInternals(scanForInternals).medianEarnYld
    : undefined;

  // Performance-since-proposal: side-adjusted move from each proposal's referencePrice to the current
  // price. For REJECTED proposals this is the realized counterfactual ("what it did after we passed");
  // for accepted ones, how the entry has fared. Reuses prices already in hand (held-position quotes +
  // the latest scan's quotes), so it's a free read — no new network calls. Fresh proposals are
  // intentionally left blank: delayed/intraday quote sources can otherwise show noisy "since" moves
  // seconds after creation. Degrades to undefined when no anchor or current price is available.
  const scanQuotes = scanForInternals?.quotesBySymbol;
  const proposalCurrentPrice = (symbol: string): number | undefined => {
    const sym = normalizeSymbol(symbol);
    if (typeof currentPrices[sym] === "number" && currentPrices[sym] > 0) return currentPrices[sym];
    const q = scanQuotes?.[sym];
    return q && typeof q.price === "number" && q.price > 0 ? q.price : undefined;
  };
  const proposalIsOldEnoughForPerformance = (createdAt?: string): boolean => {
    if (!createdAt) return true;
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs)) return true;
    return Date.now() - createdMs >= PROPOSAL_PERFORMANCE_MIN_AGE_MS;
  };
  const withProposalPerf = <T extends { proposal: TradeProposal; createdAt?: string }>(items: T[]): T[] =>
    items.map((item) => {
      if (!proposalIsOldEnoughForPerformance(item.createdAt)) return item;
      const current = proposalCurrentPrice(item.proposal.symbol);
      const pct = returnSinceProposalPct(item.proposal.referencePrice, current, item.proposal.side);
      if (pct == null) return item;
      return { ...item, performanceSinceProposalPct: pct, proposalReferencePrice: item.proposal.referencePrice, proposalCurrentPrice: current };
    });
  const recentProposalsWithPerf = withProposalPerf(recentProposals);
  const pendingProposalsWithPerf = withProposalPerf(pendingProposals);
  const macroBoard = {
    macro,
    derived: deriveMacroMetrics(macro, { marketEarningsYield }),
    signals,
    regime: determineMarketRegime(macro),
    history,
    news
  };

  const unifiedFeed = buildUnifiedFeed({
    audit,
    notifications: combinedNotifications,
    fills: unifiedFills,
    orders,
    symbolMetaBySymbol,
    accountLabelById,
    getProposalById
  });
  const clientAudit = audit.map((event) => ({
    id: event.id,
    createdAt: event.createdAt,
    kind: event.kind,
    payload: asRec(event.payload),
    connectedAccountId: event.connectedAccountId
  }));

  // One summary log per request — only when it's actually slow or something degraded, so normal
  // requests stay quiet. `timedOutSections` is populated by withDeadline(...) above whenever an
  // upstream section missed its own deadline and served a fallback.
  const snapshotElapsedMs = Date.now() - snapshotStartedAt;
  if (snapshotElapsedMs > 3000 || timedOutSections.length > 0) {
    console.warn(
      `[dashboard] snapshot ${snapshotElapsedMs}ms${timedOutSections.length ? ` (timed out: ${timedOutSections.join(",")})` : ""}`
    );
  }

  return {
    currentUser: {
      userId,
      ...(currentUserDisplay.email ? { email: currentUserDisplay.email } : {}),
      ...(currentUserDisplay.name ? { name: currentUserDisplay.name } : {}),
      ...(currentUserDisplay.imageUrl ? { imageUrl: currentUserDisplay.imageUrl } : {}),
      ...(currentUserDisplay.loginProvider ? { loginProvider: currentUserDisplay.loginProvider } : {}),
      isAdmin: isAdminEmail(currentUserDisplay.email)
    },
    // Whether at least one LLM provider has a resolvable credential for this user (own key OR operator
    // failover). The two LLM-driven actions (Run once / chat) are gated on this; everything else works
    // keyless. The client uses it to disable "Run once" with an actionable message before the 412.
    llmConfigured: userHasAnyLlmCredential(userId),
    policy,
    strategyPrompt: getStrategyPrompt(userId),
    accounts,
    accountReadiness,
    connectedAccounts,
    connectedAccountPolicies,
    portfolio: displayPortfolio,
    positions: displayPositions,
    options,
    symbolMetaBySymbol,
    stopPlanBySymbol,
    orders,
    audit: clientAudit,
    auditFeed,
    unifiedFeed,
    latestStrategyRun,
    dailyStats,
    strategyRuns: listStrategyRuns(15, userId, policy.connectedAccountId),
    pendingProposals: pendingProposalsWithPerf,
    recentProposals: recentProposalsWithPerf,
    performance,
    thesisScorecard,
    regimeScorecard,
    redTeamEfficacy,
    tax,
    profiles,
    activeProfile,
    notifications: combinedNotifications,
    notificationStatus: {
      configured: Boolean(policy.notificationSettings.webhookUrl?.trim()),
      enabledEvents: policy.notificationSettings.enabledEvents
    },
    scheduler: getSchedulerState(userId),
    webSources: getWebSourcesStatus(),
    robinhoodMcpConnected: policy.activeBroker === "robinhood" ? Boolean(getStoredMcpOAuthTokens(userId)) : true,
    autoResumeOnBoot: getAutoResumeOnBoot(userId),
    socratic: {
      decisions: socraticDecisions,
      frameworkProposals: socraticFrameworkProposals
    },
    smartMoney: {
      congress: sliceCongressByDisclosure(getCongressDataset()?.trades ?? []),
      insider: [...(getInsiderDataset()?.filings ?? [])]
        .sort((a, b) => (b.filedAt ?? "").localeCompare(a.filedAt ?? ""))
        .slice(0, 8),
      // Item 2: cached congress-score go/no-go verdict (pass/fail + stats), null when never evaluated.
      // Surfaces whether the congressional scan signal is currently statistically validated; gating on it
      // is opt-in via policy.tuning.congressGoNoGoGating.
      congressScoreVerdict: readCongressScoreVerdict(userId) ?? null
    },
    marketSession: currentMarketSession(),
    macroBoard
  };
}

function getDashboardRedTeamEfficacy(userId: string, connectedAccountId?: string) {
  const efficacy = getRedTeamEfficacy(userId, {
    auditLimit: RED_TEAM_EFFICACY_AUDIT_LIMIT,
    connectedAccountId,
    limit: 12
  });
  const redTeamOverrideKeys = new Set<string>();
  // New rows record the truthful request state. Keep the historical event kind in the union so
  // pre-migration efficacy history remains comparable; the Set prevents duplicate counting.
  for (const kind of ["red_team_veto_override_requested", "red_team_veto_overridden"] as const) {
    for (const event of listAuditByKind(kind, RED_TEAM_EFFICACY_AUDIT_LIMIT, userId, connectedAccountId)) {
      const payload = event.payload as { runId?: string; symbol?: string; side?: string } | undefined;
      if (!payload?.runId || !payload.symbol) continue;
      if (payload.side !== undefined && payload.side !== "buy" && payload.side !== "short") continue;
      redTeamOverrideKeys.add(`${payload.runId}:${normalizeSymbol(payload.symbol)}:${payload.side ?? ""}`);
    }
  }
  const appliedOverrideKeys = new Set<string>();
  for (const event of listAuditByKind("socratic_override_applied", RED_TEAM_EFFICACY_AUDIT_LIMIT, userId, connectedAccountId)) {
    const payload = event.payload as { runId?: string; symbol?: string; side?: string; conflicts?: unknown } | undefined;
    if (!payload?.runId || !payload.symbol) continue;
    if (payload.side !== undefined && payload.side !== "buy" && payload.side !== "short") continue;
    const conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
    if (!conflicts.some((conflict) => String(conflict).startsWith("red_team_veto:"))) continue;
    appliedOverrideKeys.add(`${payload.runId}:${normalizeSymbol(payload.symbol)}:${payload.side ?? ""}`);
  }
  let appliedOverrideVetoes = 0;
  for (const key of redTeamOverrideKeys) {
    if (appliedOverrideKeys.has(key)) appliedOverrideVetoes += 1;
  }
  const overrideVetoes = redTeamOverrideKeys.size;
  const vetoDecisions = efficacy.totalVetoes + overrideVetoes;
  return {
    ...efficacy,
    overrideVetoes,
    appliedOverrideVetoes,
    vetoDecisions,
    overrideSharePct: vetoDecisions > 0 ? Number(((appliedOverrideVetoes / vetoDecisions) * 100).toFixed(1)) : 0
  };
}

/** The snapshot's smart-money congress cap: sort by DISCLOSURE date (fallback: trade
 *  date) so the slice keeps the trades that most recently became PUBLIC — a freshly
 *  disclosed older trade must not be dropped in favor of an earlier-disclosed trade
 *  that merely executed later. The console card re-sorts by the same key defensively
 *  (app/console/scan/smart-money.tsx). */
export function sliceCongressByDisclosure(trades: CongressTrade[], cap = 12): CongressTrade[] {
  return [...trades]
    .sort((a, b) => (b.disclosedAt ?? b.tradedAt ?? "").localeCompare(a.disclosedAt ?? a.tradedAt ?? ""))
    .slice(0, cap);
}

function fullMarketScan(scan: StrategyDecisionLike["marketScan"] | undefined): MarketScan | undefined {
  if (!scan || !Array.isArray(scan.topCandidates) || scan.topCandidates.length === 0) return undefined;
  const first = scan.topCandidates[0] as Partial<MarketQuote>;
  return typeof first.price === "number" && typeof first.intradayChangePct === "number"
    ? (scan as MarketScan)
    : undefined;
}
