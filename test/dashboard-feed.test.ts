import { describe, expect, it } from "vitest";
import type { AuditEvent, StrategyDecision } from "../app/dashboard-types";
import { buildAuditFeed, buildSymbolMetaBySymbol, buildUnifiedFeed, UNIFIED_FEED_MAX_GROUPS } from "../src/lib/dashboard-feed";
import type { FillEvent } from "../src/lib/types";
import { enrichPositionsForDisplay, formatNotificationDisplay, formatShareQuantity, ratingTitle, sentimentTitle } from "../src/lib/dashboard-ui";
import type { EquityPosition, MarketQuote, NotificationEvent } from "../src/lib/types";

describe("dashboard feed helpers", () => {
  it("keeps stored average cost for position display math", () => {
    const rows = enrichPositionsForDisplay(
      [{ symbol: "AAPL", quantity: 2, averageCost: 150, marketValue: 500 }],
      1000
    );

    expect(rows[0]?.averageCost).toBe(150);
    expect(rows[0]?.costBasis).toBe(300);
    expect(rows[0]?.pnl).toBe(200);
    expect(rows[0]?.allocPct).toBe(50);
  });

  it("builds symbol metadata from market scan company names and proposal symbols", () => {
    const latestStrategyRun: StrategyDecision = {
      runId: "run-1",
      status: "completed",
      summary: "ok",
      proposals: [{ proposal: proposal({ symbol: "PLTR", side: "buy" }), status: "paper", reasons: [] }],
      marketScan: {
        source: "test",
        generatedAt: "2026-06-15T00:00:00.000Z",
        scannedSymbols: 1,
        returnedQuotes: 1,
        topCandidates: [quote({ symbol: "PLTR", companyName: "Palantir Technologies Inc." })],
        sectorBySymbol: {},
        quotesBySymbol: {},
        warnings: []
      }
    };

    const meta = buildSymbolMetaBySymbol({
      positions: [{ symbol: "AAPL", quantity: 1, averageCost: 100, marketValue: 110 }],
      latestStrategyRun
    });

    expect(meta.PLTR?.companyName).toBe("Palantir Technologies Inc.");
    expect(meta.AAPL).toEqual({ companyName: undefined });
  });

  it("formats historical proposal approval audits into short buy/sell titles", () => {
    // result: "paper" is a legacy value from before the local-simulation execution path was removed
    // — no code path writes it anymore, but old audit rows can still carry it (see dashboard-feed.ts).
    const audit: AuditEvent[] = [
      {
        id: "a1",
        createdAt: "2026-06-15T00:00:00.000Z",
        kind: "proposal_approved",
        payload: { proposalId: "p1", result: "paper" }
      }
    ];

    const feed = buildAuditFeed({
      audit,
      symbolMetaBySymbol: { PLTR: { companyName: "Palantir Technologies Inc." } },
      getProposalById: () => ({ proposal: proposal({ symbol: "PLTR", side: "buy" }) })
    });

    expect(feed[0]?.title).toBe("Buy PLTR Approved");
    expect(feed[0]?.detail).toContain("Local simulation (legacy)");
    expect(feed[0]?.companyName).toBe("Palantir Technologies Inc.");
  });

  it("formats notification audit rows into compact human-readable text", () => {
    const audit: AuditEvent[] = [
      {
        id: "a2",
        createdAt: "2026-06-15T00:01:00.000Z",
        kind: "notification",
        payload: {
          id: "n1",
          createdAt: "2026-06-15T00:01:00.000Z",
          type: "fill",
          title: "PLTR Paper approval fill",
          status: "skipped",
          payload: {
            fill: { symbol: "PLTR", side: "buy" }
          },
          error: "Notifications Webhook Not Configured"
        }
      }
    ];

    const feed = buildAuditFeed({ audit });

    // NotificationStatus decided vocabulary: skipped -> "Not sent" (never the raw "skipped" word).
    expect(feed[0]?.title).toBe("Buy PLTR Not sent");
    expect(feed[0]?.detail).toContain("Notifications Webhook");
  });

  it("formats recoverable issue audits into visible fallback diagnostics", () => {
    const feed = buildAuditFeed({
      audit: [
        {
          id: "a-recoverable",
          createdAt: "2026-06-15T00:03:00.000Z",
          kind: "recoverable_issue",
          payload: {
            source: "broker",
            operation: "dashboard.getPortfolioBundle",
            message: "No Robinhood MCP access token is stored.",
            fallback: "Dashboard snapshot continues without live portfolio, positions, and orders.",
            suppressedSinceLastAudit: 2
          }
        }
      ]
    });

    expect(feed[0]?.title).toBe("Broker issue");
    expect(feed[0]?.detail).toContain("No Robinhood MCP access token");
    expect(feed[0]?.detail).toContain("Fallback:");
    expect(feed[0]?.detail).toContain("2 repeats suppressed");
  });

  it("never renders raw JSON inline for an unrecognized audit kind's detail, but keeps it in fullText", () => {
    const feed = buildAuditFeed({
      audit: [
        {
          id: "a-generic",
          createdAt: "2026-06-15T00:04:00.000Z",
          kind: "notify.prefs.set",
          // Only array-valued fields here — none are scalar, so detail falls all the way back
          // to "Event recorded" rather than ever inlining the raw JSON.
          payload: {
            channels: ["push", "email"]
          }
        }
      ]
    });

    expect(feed[0]?.title).toBe("Notify.prefs.set");
    expect(feed[0]?.detail).toBe("Event recorded");
    // The raw payload stays available via the existing fullText/RawToggle affordance.
    expect(feed[0]?.fullText).toBe('{"channels":["push","email"]}');
  });

  it("derives a plain 'Key: value' detail from up to 3 scalar payload fields for an unrecognized audit kind", () => {
    const feed = buildAuditFeed({
      audit: [
        {
          id: "a-generic-scalar",
          createdAt: "2026-06-15T00:05:00.000Z",
          kind: "notify.prefs.set",
          // None of these keys are recognized by the generic-field detail helper, so this
          // exercises the scalar-fields fallback specifically. A 4th field checks the 3-field cap.
          payload: {
            webhookConfigured: false,
            retryAttempts: 2,
            target: "push",
            note: "dropped by the 3-field cap"
          }
        }
      ]
    });

    expect(feed[0]?.title).toBe("Notify.prefs.set");
    expect(feed[0]?.detail).toBe("Webhook Configured: false · Retry Attempts: 2 · Target: push");
    // The 4th field is dropped from the compact detail but nothing is lost — it's still in fullText.
    expect(feed[0]?.detail).not.toContain("note");
    expect(feed[0]?.fullText).toContain('"note":"dropped by the 3-field cap"');
  });

  it("formats notification panel rows with action title and skipped-webhook detail", () => {
    const item = formatNotificationDisplay(
      {
        id: "n1",
        createdAt: "2026-06-15T02:52:17.000Z",
        type: "fill",
        title: "PLTR sell filled",
        status: "skipped",
        payload: {
          fill: { symbol: "PLTR", side: "sell", source: "live", status: "filled" }
        },
        error: "Notifications Webhook Not Configured"
      } satisfies NotificationEvent,
      { PLTR: { companyName: "Palantir Technologies Inc." } }
    );

    expect(item.title).toBe("Sold PLTR");
    // NotificationStatus decided vocabulary: skipped -> "Not sent".
    expect(item.detail).toBe("Not sent - No notification channels enabled.");
    expect(item.companyName).toBe("Palantir Technologies Inc.");
  });

  it.each([
    ["not_configured", "Not sent - Notification channel is not configured by the operator."],
    ["no_target", "Not sent - Notification channel has no delivery target."]
  ])("maps historical raw delivery reason %s to human UI copy", (error, expected) => {
    const item = formatNotificationDisplay(
      {
        id: `raw-${error}`,
        createdAt: "2026-07-11T00:00:00.000Z",
        type: "run_failed",
        title: "Run failed",
        status: "skipped",
        payload: {},
        error
      } satisfies NotificationEvent,
      {}
    );

    expect(item.detail).toBe(expected);
  });

  it("resolves nested proposal ids for blocked notification audits", () => {
    const audit: AuditEvent[] = [
      {
        id: "a3",
        createdAt: "2026-06-15T00:02:00.000Z",
        kind: "notification",
        payload: {
          id: "n2",
          createdAt: "2026-06-15T00:02:00.000Z",
          type: "block",
          title: "META blocked",
          status: "skipped",
          payload: { proposalId: "p2" },
          error: "Notifications Webhook Not Configured"
        }
      }
    ];

    const feed = buildAuditFeed({
      audit,
      getProposalById: () => ({ proposal: proposal({ symbol: "META", side: "buy" }) })
    });

    expect(feed[0]?.title).toBe("Buy META Blocked");
  });

  it("explains Yahoo mean scale in rating tooltips", () => {
    const title = ratingTitle(
      quote({
        symbol: "META",
        analystScore: 78,
        analystRating: "Buy",
        analystBySource: {
          "yahoo-finance": { score: 75, label: "Buy", mean: 2.1 }
        }
      })
    );

    expect(title).toContain("Yahoo mean 2.1; 1.0 = Strong Buy, 3.0 = Hold, 5.0 = Strong Sell");
  });

  it("states that sentiment is locally computed from headlines", () => {
    const title = sentimentTitle(
      quote({
        symbol: "META",
        sentiment: 68,
        headlines: ["Meta beats expectations on ad revenue"],
        sources: { sentiment: "finnhub" }
      })
    );

    expect(title).toContain("locally computed from recent Finnhub headlines using keyword scoring");
  });

  it("formats share quantities according to precision and symbol-specific rules", () => {
    expect(formatShareQuantity(1.55548)).toBe("1.56");
    expect(formatShareQuantity(0.00448933)).toBe("0.00449");
    expect(formatShareQuantity(0.5)).toBe("0.5");
    expect(formatShareQuantity(12)).toBe("12");
    expect(formatShareQuantity(123.456)).toBe("123");
    // >=3 integer digits: all whole-number digits preserved (no longer truncated to
    // 3 sig figs), comma-grouped for readability.
    expect(formatShareQuantity(1234.56)).toBe("1,235");
    expect(formatShareQuantity(12345.6)).toBe("12,346");
    expect(formatShareQuantity(12489.242)).toBe("12,489");

    expect(formatShareQuantity(1.55548, "NVDA")).toBe("1.56");
    expect(formatShareQuantity(0.00448933, "intc")).toBe("0.00449");
    expect(formatShareQuantity(0.5, "QCOM")).toBe("0.5");
    expect(formatShareQuantity(12, "NVDA")).toBe("12");
    expect(formatShareQuantity(123.456, "INTC")).toBe("123");
    expect(formatShareQuantity(1234.56, "QCOM")).toBe("1,235");
    expect(formatShareQuantity(12345.6, "NVDA")).toBe("12,346");
  });

  it("consolidates ALL runId-tagged audit kinds + run-scoped notifications into one run card (owner request 2026-07-08)", () => {
    const runId = "run-xyz";
    const feed = buildUnifiedFeed({
      audit: [
        { id: "r1", createdAt: "2026-07-08T14:01:40.000Z", kind: "strategy_run", payload: { runId, status: "completed", summary: "Evaluated 1 proposal(s)." } },
        // Previously NON-allowlisted run-scoped kinds — each used to render as its own card:
        { id: "r2", createdAt: "2026-07-08T14:01:03.000Z", kind: "rag_retrieval_status", payload: { runId, rows: [] } },
        { id: "r3", createdAt: "2026-07-08T14:01:05.000Z", kind: "experience_retrieval", payload: { runId } },
        { id: "r4", createdAt: "2026-07-08T14:01:06.000Z", kind: "evidence_age_anomaly", payload: { runId } },
        { id: "r5", createdAt: "2026-07-08T14:01:33.000Z", kind: "llm_call_latency", payload: { runId, step: "bull", durationMs: 9700 } },
        { id: "r6", createdAt: "2026-07-08T14:01:39.000Z", kind: "socratic_outcome_job", payload: { runId } },
        // Allowlisted-before kinds still join:
        { id: "r7", createdAt: "2026-07-08T14:01:40.100Z", kind: "candidates_considered", payload: { runId, llmSteps: [] } },
        // A DIFFERENT run stays its own group:
        { id: "q1", createdAt: "2026-07-08T13:01:40.000Z", kind: "strategy_run", payload: { runId: "run-other", status: "completed", summary: "ok" } }
      ],
      notifications: [
        // Run-scoped alert (carries runId, no proposalId) — used to be a standalone sibling card.
        { id: "n-run", createdAt: "2026-07-08T14:01:41.000Z", type: "run_failed", title: "Run failed", status: "sent", payload: { runId, summary: "boom" } }
      ],
      fills: [],
      orders: [],
      symbolMetaBySymbol: {},
      getProposalById: () => undefined
    });

    const runGroup = feed.find((g) => g.id === `run-${runId}`);
    expect(runGroup).toBeDefined();
    // ONE card containing all seven audit sub-events plus the run-scoped notification:
    expect(runGroup!.events).toHaveLength(8);
    // Title stays anchored on the strategy_run summary event, not a sub-component:
    expect(runGroup!.events.some((ev) => ev.id === "r1")).toBe(true);
    const other = feed.find((g) => g.id === "run-run-other");
    expect(other).toBeDefined();
    // No stray standalone cards for the consolidated kinds:
    const strayIds = ["r2", "r3", "r4", "r5", "r6", "r7", "n-run"];
    for (const g of feed) {
      if (g.id === `run-${runId}`) continue;
      for (const ev of g.events) expect(strayIds).not.toContain(ev.id);
    }
  });

  it("applies Paper prefixing, custom notification tags, and grouping correctly in buildUnifiedFeed", () => {
    const feed = buildUnifiedFeed({
      audit: [
        {
          id: "a1",
          createdAt: "2026-06-15T00:00:00.000Z",
          kind: "policy_change",
          payload: { key: "maxOrderNotional" }
        },
        {
          id: "a2",
          createdAt: "2026-06-15T00:05:00.000Z",
          kind: "proposal_approved",
          payload: { proposalId: "p1", result: "paper" }
        }
      ],
      notifications: [
        {
          id: "n1",
          createdAt: "2026-06-15T00:04:00.000Z",
          type: "pending_approval",
          title: "Buy PLTR Proposal Pending",
          status: "skipped",
          payload: {
            proposalId: "p1",
            proposal: { symbol: "PLTR", side: "buy", type: "market" }
          },
          error: "Notifications Webhook Not Configured"
        }
      ],
      fills: [
        {
          id: "f1",
          proposalId: "p1",
          runId: "run-1",
          accountNumber: "A1",
          source: "paper",
          symbol: "PLTR",
          side: "buy",
          quantity: 10,
          price: 20,
          notional: 200,
          status: "filled",
          filledAt: "2026-06-15T00:06:00.000Z"
        }
      ],
      orders: [],
      symbolMetaBySymbol: { PLTR: { companyName: "Palantir Technologies Inc." } },
      getProposalById: () => ({ proposal: proposal({ symbol: "PLTR", side: "buy" }) })
    });

    const policyGroup = feed.find(g => g.tags.includes("policy change"));
    expect(policyGroup).toBeDefined();
    expect(policyGroup!.tags).toContain("notification disabled");
    expect(policyGroup!.tags).not.toContain("notification failed");

    const tradeGroup = feed.find(g => g.proposalId === "p1");
    expect(tradeGroup).toBeDefined();
    // fill.source "paper" is always a genuine broker-paper fill now (no local-simulation execution
    // path exists anymore), so the group title reads "Paper", not "Test".
    expect(tradeGroup!.title).toBe("Paper BUY PLTR");
    expect(tradeGroup!.tags).toContain("notification failed");
    expect(tradeGroup!.tags).not.toContain("notification disabled");

    const pendingApprovalEvent = tradeGroup!.events.find(ev => ev.id === "n1");
    expect(pendingApprovalEvent).toBeDefined();
    // Sub-events keep their own formatted title — only the group title (asserted above) carries the
    // Paper/live-derived prefix. There is no more group-wide "Test "-prefix rewrite of every sub-event
    // (that rewrite used to mislabel real broker-paper sub-events as "Test").
    expect(pendingApprovalEvent!.title).toBe("Buy PLTR Awaiting Approval");
  });

  it("shows an accepted broker order as pending until it fills or terminates", () => {
    const feed = buildUnifiedFeed({
      audit: [
        {
          id: "a1",
          createdAt: "2026-06-15T22:00:00.000Z",
          kind: "proposal_approved",
          payload: {
            proposalId: "p-vz",
            result: "placed",
            orderId: "alpaca-order-vz",
            brokerState: "accepted",
            fillStatus: "pending_reconciliation"
          }
        }
      ],
      notifications: [],
      fills: [
        {
          id: "f-vz",
          proposalId: "p-vz",
          runId: "run-vz",
          accountNumber: "APCA-PAPER",
          source: "paper",
          executionMode: "broker/paper",
          symbol: "VZ",
          side: "buy",
          quantity: 3,
          price: 41.25,
          notional: 123.75,
          status: "pending_reconciliation",
          brokerOrderId: "alpaca-order-vz",
          filledAt: "2026-06-15T22:00:01.000Z"
        }
      ],
      orders: [
        {
          id: "alpaca-order-vz",
          symbol: "VZ",
          side: "buy",
          type: "market",
          state: "accepted",
          quantity: 3,
          filledQuantity: 0,
          createdAt: "2026-06-15T22:00:00.000Z"
        }
      ],
      symbolMetaBySymbol: { VZ: { companyName: "Verizon Communications Inc." } },
      getProposalById: () => ({ proposal: proposal({ symbol: "VZ", side: "buy" }) })
    });

    const tradeGroup = feed.find(g => g.proposalId === "p-vz");
    expect(tradeGroup).toBeDefined();
    expect(tradeGroup!.status).toBe("pending_order");
    expect(tradeGroup!.detail).toContain("Accepted by broker; awaiting fill");
    expect(tradeGroup!.detail).toContain("Accepted");
    const orderEvent = tradeGroup!.events.find((ev) => ev.id === "alpaca-order-vz");
    expect(orderEvent?.title).toBe("Order Submitted: BUY VZ");
    expect(orderEvent?.detail).toContain("Broker state: Accepted");
  });

  it("keeps broker-filled orders working until the fill row reconciles", () => {
    const feed = buildUnifiedFeed({
      audit: [
        {
          id: "a1",
          createdAt: "2026-06-15T22:00:00.000Z",
          kind: "proposal_approved",
          payload: {
            proposalId: "p-filled-pending",
            result: "placed",
            orderId: "alpaca-order-filled-pending",
            brokerState: "filled",
            fillStatus: "pending_reconciliation"
          }
        }
      ],
      notifications: [],
      fills: [
        {
          id: "f-filled-pending",
          proposalId: "p-filled-pending",
          runId: "run-filled-pending",
          accountNumber: "APCA-PAPER",
          source: "paper",
          executionMode: "broker/paper",
          symbol: "VZ",
          side: "buy",
          quantity: 3,
          price: 41.25,
          notional: 123.75,
          status: "pending_reconciliation",
          brokerOrderId: "alpaca-order-filled-pending",
          filledAt: "2026-06-15T22:00:01.000Z"
        }
      ],
      orders: [
        {
          id: "alpaca-order-filled-pending",
          symbol: "VZ",
          side: "buy",
          type: "market",
          state: "filled",
          quantity: 3,
          filledQuantity: 3,
          createdAt: "2026-06-15T22:00:00.000Z"
        }
      ],
      symbolMetaBySymbol: { VZ: { companyName: "Verizon Communications Inc." } },
      getProposalById: () => ({ proposal: proposal({ symbol: "VZ", side: "buy" }) })
    });

    const tradeGroup = feed.find(g => g.proposalId === "p-filled-pending");
    expect(tradeGroup).toBeDefined();
    expect(tradeGroup!.status).toBe("pending_order");
    expect(tradeGroup!.detail).toContain("Filled by broker; awaiting local reconciliation");
    expect(tradeGroup!.events.some((ev) => ev.type === "fill" && ev.status === "filled")).toBe(false);
  });

  it("shows terminal broker reconciliation as a broker outcome", () => {
    const feed = buildUnifiedFeed({
      audit: [],
      notifications: [],
      fills: [
        {
          id: "f-vz-rejected",
          proposalId: "p-vz",
          runId: "run-vz",
          accountNumber: "APCA-PAPER",
          source: "paper",
          executionMode: "broker/paper",
          symbol: "VZ",
          side: "buy",
          quantity: 3,
          price: 41.25,
          notional: 123.75,
          status: "rejected",
          brokerOrderId: "alpaca-order-vz",
          filledAt: "2026-06-16T13:35:00.000Z"
        }
      ],
      orders: [],
      symbolMetaBySymbol: { VZ: { companyName: "Verizon Communications Inc." } },
      getProposalById: () => ({ proposal: proposal({ symbol: "VZ", side: "buy" }) })
    });

    const tradeGroup = feed.find(g => g.proposalId === "p-vz");
    expect(tradeGroup).toBeDefined();
    expect(tradeGroup!.status).toBe("rejected");
    expect(tradeGroup!.detail).toContain("Broker reported Rejected");
    expect(tradeGroup!.detail).not.toContain("Rejected manually");
  });

  it("shows synchronous broker declines as broker outcomes, not manual rejections", () => {
    const feed = buildUnifiedFeed({
      audit: [
        {
          id: "audit-broker-reject",
          createdAt: "2026-06-16T13:36:00.000Z",
          kind: "order_rejected_by_broker",
          payload: {
            proposalId: "p-broker-reject",
            symbol: "VZ",
            side: "buy",
            orderId: "alpaca-order-rejected",
            brokerState: "rejected"
          }
        }
      ],
      notifications: [],
      fills: [],
      orders: [],
      symbolMetaBySymbol: { VZ: { companyName: "Verizon Communications Inc." } },
      getProposalById: () => ({ proposal: proposal({ symbol: "VZ", side: "buy" }) })
    });

    const tradeGroup = feed.find(g => g.proposalId === "p-broker-reject");
    expect(tradeGroup).toBeDefined();
    expect(tradeGroup!.status).toBe("rejected");
    expect(tradeGroup!.detail).toContain("Broker state Rejected");
    // The full broker order id is never shown inline in the detail — only the short tag.
    expect(tradeGroup!.detail).toContain("Order ALPACAOR");
    expect(tradeGroup!.detail).not.toContain("alpaca-order-rejected");
    expect(tradeGroup!.detail).not.toContain("Rejected manually");
    // ...but it's never lost either — the sub-event's fullText carries the complete raw id.
    const rejectEvent = tradeGroup!.events.find((ev) => ev.id === "audit-broker-reject");
    expect(rejectEvent?.fullText).toContain("alpaca-order-rejected");
  });

  it("consolidates a strategy run's audit events into ONE run group with sub-rows (#8)", () => {
    const runId = "run-consolidate";
    const feed = buildUnifiedFeed({
      audit: [
        {
          id: "a-run",
          createdAt: "2026-07-01T10:00:00.000Z",
          kind: "strategy_run",
          payload: { runId, status: "completed", summary: "Evaluated 3 proposal(s)." },
          connectedAccountId: "acct-1"
        },
        {
          id: "a-div",
          createdAt: "2026-07-01T10:00:01.000Z",
          kind: "rationale_diversity",
          payload: { runId, count: 3, meanPairwiseSimilarity: 0.42 }
        },
        {
          id: "a-cand",
          createdAt: "2026-07-01T10:00:02.000Z",
          kind: "candidates_considered",
          payload: { runId, chosen: [{ symbol: "PLTR" }], topSkipped: [] }
        },
        {
          id: "a-snap",
          createdAt: "2026-07-01T10:00:03.000Z",
          kind: "signal_snapshot",
          payload: { runId, asOf: "2026-07-01", signals: [] }
        }
      ] as AuditEvent[] & Array<{ connectedAccountId?: string }>,
      notifications: [],
      fills: [],
      orders: [],
      symbolMetaBySymbol: {},
      accountLabelById: { "acct-1": "Alpaca Paper" }
    });

    const runGroups = feed.filter((g) => g.id === `run-${runId}`);
    expect(runGroups.length).toBe(1);
    const group = runGroups[0]!;
    expect(group.events.length).toBe(4);
    // The strategy_run event is the primary: rendered once as the card's title/detail.
    expect(group.title).toBe("Strategy run completed");
    expect(group.detail).toContain("Evaluated 3 proposal(s).");
    expect(group.status).toBe("completed");
    // Account attribution from any event in the group reaches the card (#8).
    expect(group.connectedAccountId).toBe("acct-1");
    expect(group.accountLabel).toBe("Alpaca Paper");
    // No stray one-event groups remain for the run-scoped kinds.
    expect(feed.some((g) => g.id === "audit-a-div" || g.id === "audit-a-cand" || g.id === "audit-a-snap")).toBe(false);
  });

  it("humanizes web_source_refresh and congress_share_daily ops events (#9, #11)", () => {
    const feed = buildAuditFeed({
      audit: [
        {
          id: "ws-1",
          createdAt: "2026-07-01T04:00:00.000Z",
          kind: "web_source_refresh",
          payload: { id: "congress", ok: true, recordCount: 103, sources: ["congress.trade"] }
        },
        {
          id: "cs-1",
          createdAt: "2026-07-01T04:01:00.000Z",
          kind: "congress_share_daily",
          payload: { ok: false, tickers: 515, priced: 515, posts: 34, failedPosts: 30, sent: [] }
        }
      ]
    });

    expect(feed[0]?.title).toBe("Web source refresh");
    expect(feed[0]?.detail).toBe("Refreshed 103 congressional-trade entries");
    expect(feed[0]?.fullText).toContain('"recordCount":103'); // raw JSON stays available behind a toggle

    expect(feed[1]?.title).toBe("Congress daily share");
    expect(feed[1]?.detail).toBe("515 of 515 tickers priced · 34 posts sent · 30 failed");
    expect(feed[1]?.fullText).toContain('"failedPosts":30');
  });

  it("humanizes notify.bridge.error ops events into a one-liner (#39)", () => {
    const feed = buildAuditFeed({
      audit: [
        {
          id: "nbe-1",
          createdAt: "2026-07-02T04:00:00.000Z",
          kind: "notify.bridge.error",
          payload: { type: "pending_approval", error: "ECONNREFUSED: bridge unreachable" }
        }
      ]
    });

    expect(feed[0]?.title).toBe("Notification delivery failed");
    expect(feed[0]?.detail).toBe("Could not deliver pending_approval notification · ECONNREFUSED: bridge unreachable");
    expect(feed[0]?.fullText).toContain('"error":"ECONNREFUSED: bridge unreachable"'); // raw JSON stays available behind a toggle
  });

  it("labels the notification-audit catch-all with the decided NotificationEventType/Status vocabulary", () => {
    // budget_alert and provider_degraded are two of the types that used to render as a raw,
    // all-lowercase enum ("budget_alert sent") via humanizeNotificationType.
    const feed = buildAuditFeed({
      audit: [
        {
          id: "nb-1",
          createdAt: "2026-07-03T04:00:00.000Z",
          kind: "notification",
          payload: { id: "nb-1", createdAt: "2026-07-03T04:00:00.000Z", type: "budget_alert", title: "Strategy run skipped — over budget", status: "sent" }
        },
        {
          id: "nb-2",
          createdAt: "2026-07-03T04:01:00.000Z",
          kind: "notification",
          payload: { id: "nb-2", createdAt: "2026-07-03T04:01:00.000Z", type: "provider_degraded", title: "Finnhub degraded", status: "failed", error: "Timed out" }
        }
      ]
    });

    expect(feed[0]?.title).toBe("Budget alert Sent");
    expect(feed[1]?.title).toBe("Data provider degraded Delivery failed");
  });

  it("labels fill and broker-order detail strings with the decided status/order-type vocabulary", () => {
    const feed = buildUnifiedFeed({
      audit: [],
      notifications: [],
      fills: [
        {
          id: "f-partial",
          accountNumber: "A1",
          source: "live",
          symbol: "MSFT",
          side: "buy",
          quantity: 5,
          price: 400,
          notional: 2000,
          status: "partially_filled",
          filledAt: "2026-07-03T00:00:00.000Z"
        }
      ],
      orders: [
        {
          id: "order-stop-limit",
          symbol: "MSFT",
          side: "buy",
          type: "stop_limit",
          state: "accepted",
          quantity: 5,
          filledQuantity: 0,
          createdAt: "2026-07-03T00:00:00.000Z"
        }
      ],
      symbolMetaBySymbol: {}
    });

    const fillGroup = feed.find((g) => g.id === "fill-f-partial");
    expect(fillGroup?.detail).toContain("Partially filled");
    expect(fillGroup?.detail).not.toContain("partially_filled");

    const orderGroup = feed.find((g) => g.id === "order-order-stop-limit");
    expect(orderGroup?.detail).toContain("Stop-limit");
    expect(orderGroup?.detail).not.toContain("stop_limit");
  });

  it("carries a notification's connectedAccountId onto its unified-feed group (#10)", () => {
    const feed = buildUnifiedFeed({
      audit: [],
      notifications: [
        {
          id: "n-other-acct",
          createdAt: "2026-07-01T12:00:00.000Z",
          type: "pending_approval",
          title: "Buy PLTR Proposal Pending",
          status: "skipped",
          payload: { proposalId: "p-acct", proposal: { symbol: "PLTR", side: "buy" } },
          connectedAccountId: "acct-test"
        } as NotificationEvent
      ],
      fills: [],
      orders: [],
      symbolMetaBySymbol: {},
      accountLabelById: { "acct-test": "Local simulator" },
      getProposalById: () => ({ proposal: proposal({ symbol: "PLTR", side: "buy" }) })
    });

    const group = feed.find((g) => g.proposalId === "p-acct");
    expect(group).toBeDefined();
    expect(group!.connectedAccountId).toBe("acct-test");
    expect(group!.accountLabel).toBe("Local simulator");
  });

  it("caps buildUnifiedFeed output at the source-level limit, newest-first", () => {
    // 200 independent (ungrouped) fills — well above the client's 50-group render slice — so the
    // only thing keeping the payload bounded is the source-level cap inside buildUnifiedFeed.
    const total = 200;
    const fills: FillEvent[] = Array.from({ length: total }, (_, i) => ({
      id: `f${i}`,
      accountNumber: "CAP1",
      source: "paper",
      symbol: "AAA",
      side: "buy",
      quantity: 1,
      price: 10,
      notional: 10,
      status: "filled",
      // Ascending timestamps so the newest is the highest index.
      filledAt: `2026-06-15T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`
    }));

    const feed = buildUnifiedFeed({
      audit: [],
      notifications: [],
      fills,
      orders: [],
      symbolMetaBySymbol: {}
    });

    expect(feed.length).toBe(UNIFIED_FEED_MAX_GROUPS);
    expect(UNIFIED_FEED_MAX_GROUPS).toBe(60);
    // Newest-first: the very latest fill must survive the cap and lead the feed.
    expect(feed[0]!.updatedAt).toBe(fills[total - 1]!.filledAt);
    // Sorted strictly newest-first across the whole capped array.
    for (let i = 1; i < feed.length; i++) {
      expect(feed[i - 1]!.updatedAt >= feed[i]!.updatedAt).toBe(true);
    }
  });

  it("never caps proposal-bearing groups (ledger reconciliation) — only the proposal-less tail", () => {
    // 80 fills with distinct proposalIds → 80 proposal-bearing groups. The decision ledger reconciles
    // statuses for up to 100 recent proposals from this feed, so none may be dropped even though 80 > 60.
    const proposalFills: FillEvent[] = Array.from({ length: 80 }, (_, i) => ({
      id: `pf${i}`,
      accountNumber: "CAP2",
      source: "paper",
      symbol: "AAA",
      side: "buy",
      quantity: 1,
      price: 10,
      notional: 10,
      status: "filled",
      proposalId: `prop-${i}`,
      filledAt: `2026-06-15T01:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`
    }));
    // 100 proposal-less fills → render-only, capped.
    const looseFills: FillEvent[] = Array.from({ length: 100 }, (_, i) => ({
      id: `lf${i}`,
      accountNumber: "CAP2",
      source: "paper",
      symbol: "BBB",
      side: "buy",
      quantity: 1,
      price: 10,
      notional: 10,
      status: "filled",
      filledAt: `2026-06-15T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`
    }));

    const feed = buildUnifiedFeed({
      audit: [],
      notifications: [],
      fills: [...proposalFills, ...looseFills],
      orders: [],
      symbolMetaBySymbol: {}
    });

    const proposalGroups = feed.filter((g) => g.proposalId);
    const looseGroups = feed.filter((g) => !g.proposalId);
    expect(proposalGroups.length).toBe(80); // every proposal group survives — reconciliation stays complete
    expect(new Set(proposalGroups.map((g) => g.proposalId)).size).toBe(80);
    expect(looseGroups.length).toBe(UNIFIED_FEED_MAX_GROUPS); // only the render-only tail is capped
    for (let i = 1; i < feed.length; i++) {
      expect(feed[i - 1]!.updatedAt >= feed[i]!.updatedAt).toBe(true); // still globally newest-first
    }
  });
});

function proposal(input: { symbol: string; side: "buy" | "sell" }) {
  return {
    symbol: input.symbol,
    side: input.side,
    type: "market" as const,
    timeInForce: "gfd" as const,
    marketHours: "regular_hours" as const,
    rationale: "test",
    tradeThesisTag: "test",
    entryMarketRegime: "test"
  };
}

function quote(input: Partial<MarketQuote> & { symbol: string }): MarketQuote {
  return {
    price: 100,
    volume: 1,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 0,
    ...input
  };
}
