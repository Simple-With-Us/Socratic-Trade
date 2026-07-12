import type { EquityOrder, EquityPosition, FillEvent, NotificationEvent, PendingProposal, TradeProposal } from "./types";
import { formatQuantity } from "./money";
import { isActiveBrokerOrderState } from "./broker-held-orders";

export interface SymbolMeta {
  companyName?: string;
}

export interface AuditFeedItem {
  id: string;
  createdAt: string;
  title: string;
  detail: string;
  fullText: string;
  symbol?: string;
  companyName?: string;
  connectedAccountId?: string;
  accountLabel?: string;
}

interface SourceAuditEvent {
  id: string;
  createdAt: string;
  kind: string;
  payload: unknown;
  connectedAccountId?: string;
}

export interface StrategyDecisionLike {
  runId: string;
  createdAt?: string;
  status: "completed" | "failed";
  summary: string;
  proposals: Array<{ proposal: TradeProposal; status: string; reasons: string[]; orderId?: string }>;
  marketScan?: {
    topCandidates: Array<{ symbol: string; companyName?: string }>;
    quotesBySymbol?: Record<string, { symbol: string; companyName?: string }>;
  };
}

export function buildSymbolMetaBySymbol(input: {
  positions?: EquityPosition[];
  orders?: EquityOrder[];
  pendingProposals?: PendingProposal[];
  latestStrategyRun?: StrategyDecisionLike;
}): Record<string, SymbolMeta> {
  const meta: Record<string, SymbolMeta> = {};

  const ensure = (symbol?: string, companyName?: string) => {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return;
    meta[normalized] = {
      companyName: companyName?.trim() || meta[normalized]?.companyName
    };
  };

  for (const position of input.positions ?? []) ensure(position.symbol);
  for (const order of input.orders ?? []) ensure(order.symbol);
  for (const pending of input.pendingProposals ?? []) ensure(pending.proposal.symbol);

  const decision = input.latestStrategyRun;
  for (const proposal of decision?.proposals ?? []) ensure(proposal.proposal.symbol);
  for (const quote of decision?.marketScan?.topCandidates ?? []) ensure(quote.symbol, quote.companyName);
  for (const quote of Object.values(decision?.marketScan?.quotesBySymbol ?? {})) ensure(quote.symbol, quote.companyName);

  return meta;
}

export function buildAuditFeed(input: {
  audit: SourceAuditEvent[];
  symbolMetaBySymbol?: Record<string, SymbolMeta>;
  accountLabelById?: Record<string, string>;
  getProposalById?: (proposalId: string) => { proposal: TradeProposal } | undefined;
}): AuditFeedItem[] {
  const symbolMetaBySymbol = input.symbolMetaBySymbol ?? {};
  const accountLabelById = input.accountLabelById ?? {};

  return input.audit.map((event) => {
    const payload = asRecord(event.payload);
    const proposalLookup = proposalFromPayload(payload, input.getProposalById);
    const symbol = normalizeSymbol(
      stringValue(payload.symbol) ??
        stringValue(proposalLookup?.proposal?.symbol) ??
        notificationSymbol(payload)
    );
    const side = normalizeSide(stringValue(payload.side) ?? stringValue(proposalLookup?.proposal?.side) ?? notificationSide(payload));
    const companyName = symbol ? symbolMetaBySymbol[symbol]?.companyName : undefined;

    const feed = formatAuditEvent(event.kind, payload, { symbol, side, companyName });
    return {
      id: event.id,
      createdAt: event.createdAt,
      title: feed.title,
      detail: feed.detail,
      fullText: feed.fullText ?? feed.detail,
      symbol,
      companyName,
      connectedAccountId: event.connectedAccountId,
      accountLabel: event.connectedAccountId ? accountLabelById[event.connectedAccountId] : undefined
    };
  });
}

function formatAuditEvent(
  kind: string,
  payload: Record<string, unknown>,
  context: { symbol?: string; side?: "buy" | "sell"; companyName?: string }
): { title: string; detail: string; fullText?: string } {
  if (kind === "strategy_run") {
    const llm = formatLlmSteps(payload.llmSteps);
    const summary = stringValue(payload.summary) ?? "No summary";
    return {
      title: payload.status === "failed" ? "Strategy run failed" : "Strategy run completed",
      detail: joinDetail([summary, llm]) ?? summary
    };
  }

  if (kind === "llm_step") {
    const label = stringValue(payload.label) ?? "LLM step";
    const status = stringValue(payload.status) ?? "completed";
    const provider = stringValue(payload.provider);
    const model = stringValue(payload.model);
    const proposalCount = numberValue(payload.proposalCount);
    const reason = stringValue(payload.reason);
    return {
      title: `${label} ${status}`,
      detail: joinDetail([
        model && provider ? `${model} via ${capitalize(provider)}` : model ?? provider,
        proposalCount !== undefined ? `${proposalCount} proposal${proposalCount === 1 ? "" : "s"}` : undefined,
        reason
      ]) ?? "Model step recorded"
    };
  }

  if (kind === "policy_change") {
    return {
      title: "Policy updated",
      detail: `Changed ${stringValue(payload.key) ?? "settings"}`
    };
  }

  if (kind === "profile_change") {
    const action = stringValue(payload.action) ?? "updated";
    return {
      title: `Profile ${action}`,
      detail: shortText(stringValue(payload.name) ?? "Strategy profile")
    };
  }

  if (kind === "proposal_approved") {
    const result = stringValue(payload.result) ?? "approved";
    const titlePrefix = sideLabel(context.side, context.symbol) ?? "Proposal";
    const title =
      result === "blocked"
        ? `${titlePrefix} Blocked`
        : result === "placed" || result === "paper"
          ? `${titlePrefix} Approved`
          : `${titlePrefix} ${capitalize(result)}`;
    const detail =
      joinDetail([
        // "paper" here is a legacy result value from before the local-simulation execution path was
        // removed — no code path writes it anymore, but old audit rows can still carry it.
        result === "paper" ? "Local simulation (legacy)" : undefined,
        result === "placed" && stringValue(payload.fillStatus) === "pending_reconciliation" ? "Broker accepted order; pending execution" : undefined,
        result === "placed" && stringValue(payload.fillStatus) !== "pending_reconciliation" ? "Order placed" : undefined,
        result === "placed" && stringValue(payload.brokerState) ? `Broker state ${readableBrokerState(stringValue(payload.brokerState))}` : undefined,
        stringValue(payload.orderId) ? `Order ${stringValue(payload.orderId)}` : undefined,
        firstReason(payload)
      ]) ?? "Awaiting next update";
    return { title, detail };
  }

  if (kind === "proposal_rejected") {
    return {
      title: `${sideLabel(context.side, context.symbol) ?? "Proposal"} Rejected`,
      detail: "Rejected manually"
    };
  }

  if (kind === "order_rejected_by_broker") {
    const brokerState = stringValue(payload.brokerState);
    const orderId = stringValue(payload.orderId);
    const reason = stringValue(payload.reason) ?? stringValue(payload.error);
    return {
      title: `${sideLabel(context.side, context.symbol) ?? context.symbol ?? "Order"} Broker Declined`,
      detail: joinDetail([
        brokerState ? `Broker state ${readableBrokerState(brokerState)}` : "Broker declined the order",
        orderId ? `Order ${orderId}` : undefined,
        reason
      ]) ?? "Broker declined the order"
    };
  }

  if (kind === "notification") {
    const notification = payload as unknown as NotificationEvent;
    const symbol = normalizeSymbol(notificationSymbol(payload)) ?? context.symbol;
    const side = normalizeSide(notificationSide(payload)) ?? context.side;
    const statusVerb = notification.status === "sent" ? "sent" : notification.status === "failed" ? "failed" : "skipped";
    if (notification.type === "fill") {
      return {
        title: `${sideLabel(side, symbol) ?? symbol ?? "Trade"} ${capitalize(statusVerb)}`,
        detail: notification.error ? shortText(notification.error) : shortText(notification.title)
      };
    }
    if (notification.type === "pending_approval") {
      return {
        title: `${sideLabel(side, symbol) ?? symbol ?? "Proposal"} Approval Pending`,
        detail: notification.error ? shortText(notification.error) : shortText(notification.title)
      };
    }
    if (notification.type === "block") {
      return {
        title: `${sideLabel(side, symbol) ?? symbol ?? "Proposal"} Blocked`,
        detail: notification.error ? shortText(notification.error) : shortText(firstReason(asRecord(notification.payload)) ?? notification.title)
      };
    }
    return {
      title: `${humanizeNotificationType(notification.type)} ${capitalize(statusVerb)}`,
      detail: notification.error ? shortText(notification.error) : shortText(notification.title)
    };
  }

  if (kind === "fill_reconciled") {
    return {
      title: `${context.symbol ?? "Fill"} reconciled`,
      detail: joinDetail([
        stringValue(payload.status),
        numberValue(payload.quantity) ? `Qty ${trimNumber(numberValue(payload.quantity) ?? 0)}` : undefined,
        numberValue(payload.price) ? `@ ${trimCurrency(numberValue(payload.price) ?? 0)}` : undefined
      ]) ?? "Broker state synced"
    };
  }

  if (kind === "order_cancel") {
    return {
      title: "Order cancel requested",
      detail: shortText(stringValue(payload.orderId) ? `Order ${stringValue(payload.orderId)}` : "Broker request submitted")
    };
  }

  if (kind === "post_mortem_reflection") {
    return {
      title: "Post Mortem Reflection",
      detail: stringValue(payload.summary) ?? "No reflection summary"
    };
  }

  if (kind === "recoverable_issue") {
    const source = stringValue(payload.source) ?? "system";
    const operation = stringValue(payload.operation) ?? "operation";
    const repeats = numberValue(payload.suppressedSinceLastAudit);
    const message = plainRecoverableMessage(stringValue(payload.message) ?? operation);
    return {
      title: `${capitalize(source)} issue`,
      detail: joinDetail([
        message,
        stringValue(payload.fallback) ? `Fallback: ${stringValue(payload.fallback) ?? ""}` : undefined,
        repeats && repeats > 0 ? `${repeats} repeat${repeats === 1 ? "" : "s"} suppressed` : undefined
      ]) ?? operation
    };
  }

  if (kind === "candidates_considered") {
    const chosen = Array.isArray(payload.chosen) ? payload.chosen : [];
    const skipped = Array.isArray(payload.topSkipped) ? payload.topSkipped : [];
    const skippedSymbols = skipped
      .map((item) => asRecord(item))
      .map((item) => {
        const symbol = stringValue(item.symbol);
        const score = numberValue(item.score);
        return symbol ? `${symbol}${score !== undefined ? ` ${Math.round(score)}` : ""}` : undefined;
      })
      .filter(Boolean)
      .slice(0, 8)
      .join(", ");
    return {
      title: "Candidates considered",
      detail: joinDetail([
        `Chosen ${chosen.length}`,
        skipped.length > 0 ? `Top skipped: ${skippedSymbols || `${skipped.length} candidates`}` : "No skipped candidates",
        formatLlmSteps(payload.llmSteps)
      ]) ?? "No candidates recorded"
    };
  }

  if (kind === "signal_snapshot") {
    const signals = Array.isArray(payload.signals) ? payload.signals : [];
    const chosen = signals.filter((item) => asRecord(item).chosen === true).length;
    const asOf = stringValue(payload.asOf);
    return {
      title: "Signal snapshot",
      detail: joinDetail([
        `${signals.length} candidate signal${signals.length === 1 ? "" : "s"}`,
        chosen > 0 ? `${chosen} chosen` : "0 chosen",
        asOf ? `as of ${asOf}` : undefined
      ]) ?? "Signal evidence captured"
    };
  }

  if (kind === "rationale_diversity") {
    const count = numberValue(payload.count) ?? 0;
    const mean = numberValue(payload.meanPairwiseSimilarity);
    return {
      title: "Rationale diversity",
      detail: joinDetail([
        `${count} rationale${count === 1 ? "" : "s"} analyzed`,
        mean !== undefined ? `mean similarity ${mean.toFixed(2)}` : undefined,
        formatLlmSteps(payload.llmSteps)
      ]) ?? "Rationale check recorded"
    };
  }

  if (kind.startsWith("run_skipped_")) {
    return {
      title: "Strategy run skipped",
      detail: genericAuditDetail(payload) ?? humanizeKind(kind)
    };
  }

  if (kind === "wash_sale_ira_disregarded") {
    // IRA rebuy proceeded under taxSettings.iraWashSaleHandling = "disregard" — surface the
    // verbatim annotation + priced provenance so the acceptance is visible in Activity.
    const symbol = stringValue(payload.symbol);
    const washSale = asRecord(payload.washSale);
    const note = stringValue(washSale.note) ?? "Wash Sale (Technically, but IRA purchase unreported to IRS)";
    const cost = numberValue(washSale.estimatedTaxCostUsd);
    const account = stringValue(washSale.account);
    return {
      title: `IRA wash sale disregarded${symbol ? ` — ${symbol}` : ""}`,
      detail:
        joinDetail([
          note,
          account ? `loss in ${account}` : undefined,
          cost !== undefined ? `~$${cost.toFixed(2)} deduction technically forfeited` : undefined
        ]) ?? note,
      fullText: serializeAuditPayload(payload)
    };
  }

  // ── Ops / housekeeping events: humanized one-liners (raw JSON only in fullText) ──

  if (kind === "web_source_refresh") {
    const id = stringValue(payload.id) ?? "web source";
    const label = WEB_SOURCE_LABELS[id] ?? id;
    const ok = payload.ok === true;
    const recordCount = numberValue(payload.recordCount) ?? 0;
    const fresh = numberValue(payload.fresh);
    const warning = stringValue(payload.warning) ?? stringValue(payload.reason);
    return {
      title: "Web source refresh",
      detail: ok
        ? joinDetail([
            `Refreshed ${recordCount} ${label} ${recordCount === 1 ? "entry" : "entries"}`,
            fresh !== undefined ? `${fresh} new` : undefined,
            warning
          ]) ?? `Refreshed ${label}`
        : joinDetail([`${capitalize(label)} refresh failed`, warning]) ?? `${capitalize(label)} refresh failed`,
      fullText: serializeAuditPayload(payload)
    };
  }

  if (kind === "congress_share_daily") {
    const ok = payload.ok === true;
    const reason = stringValue(payload.reason);
    const tickers = numberValue(payload.tickers) ?? 0;
    const priced = numberValue(payload.priced) ?? 0;
    const posts = numberValue(payload.posts) ?? 0;
    const failedPosts = numberValue(payload.failedPosts) ?? 0;
    return {
      title: "Congress daily share",
      detail:
        reason === "nothing-to-send"
          ? "Nothing to send today"
          : joinDetail([
              `${priced} of ${tickers} tickers priced`,
              `${posts} post${posts === 1 ? "" : "s"} sent`,
              failedPosts > 0 ? `${failedPosts} failed` : undefined,
              !ok && failedPosts === 0 ? "did not complete" : undefined
            ]) ?? "Daily share batch recorded",
      fullText: serializeAuditPayload(payload)
    };
  }

  if (kind === "notify.bridge.error") {
    const type = stringValue(payload.type);
    const errorMessage = stringValue(payload.error);
    return {
      title: "Notification delivery failed",
      detail: joinDetail([`Could not deliver ${type ?? "a"} notification`, errorMessage]) ?? "Could not deliver a notification",
      fullText: serializeAuditPayload(payload)
    };
  }

  const serializedPayload = serializeAuditPayload(payload);
  const detail = genericAuditDetail(payload) ?? serializedPayload ?? "Event recorded";
  return {
    title: humanizeKind(kind),
    detail,
    fullText: serializedPayload ?? detail
  };
}

function proposalFromPayload(
  payload: Record<string, unknown>,
  getProposalById?: (proposalId: string) => { proposal: TradeProposal } | undefined
) {
  const nested = asRecord(payload.payload);
  const proposalId = stringValue(payload.proposalId) ?? stringValue(nested.proposalId);
  return proposalId && getProposalById ? getProposalById(proposalId) : undefined;
}

function firstReason(payload: Record<string, unknown>): string | undefined {
  const reason = stringValue(payload.reason);
  if (reason) return reason;
  const reasons = payload.reasons;
  if (Array.isArray(reasons)) {
    const first = reasons.find((item) => typeof item === "string");
    if (typeof first === "string") return first;
  }
  return undefined;
}

function notificationSymbol(payload: Record<string, unknown>): string | undefined {
  const nested = asRecord(payload.payload);
  const fill = asRecord(nested.fill);
  const proposal = asRecord(nested.proposal);
  return stringValue(fill.symbol) ?? stringValue(proposal.symbol) ?? symbolFromTitle(stringValue(payload.title));
}

function notificationSide(payload: Record<string, unknown>): string | undefined {
  const nested = asRecord(payload.payload);
  const fill = asRecord(nested.fill);
  const proposal = asRecord(nested.proposal);
  return stringValue(fill.side) ?? stringValue(proposal.side);
}

function symbolFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const match = title.match(/\b[A-Z][A-Z0-9.-]{0,9}\b/);
  return match?.[0];
}

function normalizeSymbol(symbol?: string): string | undefined {
  const value = symbol?.trim().toUpperCase();
  return value ? value : undefined;
}

function normalizeSide(side?: string): "buy" | "sell" | undefined {
  return side === "buy" || side === "sell" ? side : undefined;
}

function sideLabel(side?: "buy" | "sell", symbol?: string): string | undefined {
  if (!symbol) return undefined;
  if (!side) return symbol;
  return `${side === "buy" ? "Buy" : "Sell"} ${symbol}`;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function shortText(value: string): string {
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function humanizeNotificationType(type?: string): string {
  if (!type) return "Notification";
  return type.replace(/_/g, " ");
}

function humanizeKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

/** Human names for the web-source connector ids used in `web_source_refresh` audits. */
const WEB_SOURCE_LABELS: Record<string, string> = {
  congress: "congressional-trade",
  "congress-analytics": "congressional-analytics",
  insider: "insider-filing (SEC Form 4)",
  finra: "short-interest (FINRA)",
  sec8k: "SEC 8-K filing",
  technical: "technical-signal"
};

/** Pure-ops audit kinds: background data refreshes and housekeeping that are not
 *  account decisions. The console collapses these into a "System" group. */
export const OPS_AUDIT_KINDS = new Set(["web_source_refresh", "congress_share_daily", "notify.bridge.error"]);

/** Audit kinds that belong to one strategy run and are consolidated into a single
 *  `run-<runId>` group in the unified feed (plus any `run_skipped_*` kind). */
const RUN_SCOPED_AUDIT_KINDS = new Set([
  "strategy_run",
  "rationale_diversity",
  "candidates_considered",
  "signal_snapshot",
  "llm_step"
]);

function runGroupIdForAudit(kind: string, payload: Record<string, unknown>): string | undefined {
  if (!RUN_SCOPED_AUDIT_KINDS.has(kind) && !kind.startsWith("run_skipped_")) return undefined;
  const runId = stringValue(payload.runId);
  return runId ? `run-${runId}` : undefined;
}

function trimNumber(value: number): string {
  const decimals = Math.abs(value) >= 1 ? 3 : 4;
  return value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function trimCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function joinDetail(parts: Array<string | undefined>): string | undefined {
  const filtered = parts.filter(Boolean);
  return filtered.length > 0 ? filtered.join(" · ") : undefined;
}

function genericAuditDetail(payload: Record<string, unknown>): string | undefined {
  const details = asRecord(payload.details);
  const symbol = stringValue(payload.symbol) ?? stringValue(details.symbol);
  const side = stringValue(payload.side);
  const status = stringValue(payload.status);
  const operation = stringValue(payload.operation);
  const reason = stringValue(payload.reason);
  const summary = stringValue(payload.summary);
  const message = stringValue(payload.message);
  const error = stringValue(payload.error);
  const orderId = stringValue(payload.orderId);
  const runId = stringValue(payload.runId);
  const count = numberValue(payload.count) ?? numberValue(payload.recordCount) ?? numberValue(payload.candidateCount);
  return joinDetail([
    reason,
    summary,
    message,
    error,
    operation,
    symbol ? [side, symbol].filter(Boolean).join(" ") : side,
    status ? `Status: ${status}` : undefined,
    orderId ? `Order ${orderId}` : undefined,
    count !== undefined ? `Count ${count}` : undefined,
    runId ? `Run ${runId}` : undefined
  ]);
}

function serializeAuditPayload(payload: Record<string, unknown>): string | undefined {
  if (Object.keys(payload).length === 0) return undefined;
  try {
    return JSON.stringify(payload);
  } catch {
    return undefined;
  }
}

function plainRecoverableMessage(message: string): string {
  if (/unexpected additional properties/i.test(message) && /validating/i.test(message)) {
    return "Robinhood rejected the quote request parameters.";
  }
  return message;
}

function formatLlmSteps(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parts = value
    .map((item) => {
      const step = asRecord(item);
      const label = stringValue(step.label) ?? stringValue(step.step) ?? "LLM";
      const model = stringValue(step.model);
      const provider = stringValue(step.provider);
      const status = stringValue(step.status);
      if (!model && !provider) return undefined;
      const modelPart = model && provider ? `${model}/${provider}` : model ?? provider;
      return `${label}: ${modelPart}${status && status !== "completed" ? ` (${status})` : ""}`;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function readableBrokerState(state?: string): string {
  if (!state) return "Pending";
  return state.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isTerminalBrokerState(state?: string): boolean {
  return Boolean(state && ["canceled", "cancelled", "rejected", "failed", "expired"].includes(state));
}

function isPendingBrokerState(state?: string): boolean {
  const normalized = String(state ?? "").trim().toLowerCase();
  return isActiveBrokerOrderState(normalized) || ["done_for_day", "stopped", "calculated"].includes(normalized);
}

function brokerOrderDetail(order: EquityOrder | undefined, fillStatus?: string): string {
  if (!order) {
    if (fillStatus === "pending_reconciliation") return "Broker order accepted; awaiting broker status update.";
    if (fillStatus === "filled") return "Filled by broker.";
    if (fillStatus === "partially_filled") return "Partially filled by broker.";
    if (isTerminalBrokerState(fillStatus)) return `Broker reported ${readableBrokerState(fillStatus)}.`;
    return "Awaiting broker status update.";
  }
  const formattedFilled = formatQuantity(order.filledQuantity, normalizeSymbol(order.symbol));
  const formattedTotal = formatQuantity(order.quantity, normalizeSymbol(order.symbol));
  const prefix =
    fillStatus === "pending_reconciliation" && order.state === "filled"
      ? "Filled by broker; awaiting local reconciliation"
      : order.state === "filled"
      ? "Filled by broker"
      : order.state === "partially_filled"
        ? "Partially filled by broker"
        : isTerminalBrokerState(order.state)
          ? `Broker reported ${readableBrokerState(order.state)}`
          : "Accepted by broker; awaiting fill";
  return `${prefix}: ${readableBrokerState(order.state)} · Qty ${formattedFilled} / ${formattedTotal} · ${order.type}`;
}

function brokerOrderTitle(order: EquityOrder): string {
  const side = order.side.toUpperCase();
  const symbol = normalizeSymbol(order.symbol);
  if (order.state === "filled") return `Order Filled: ${side} ${symbol}`;
  if (order.state === "partially_filled") return `Order Partially Filled: ${side} ${symbol}`;
  if (isTerminalBrokerState(order.state)) return `Order ${readableBrokerState(order.state)}: ${side} ${symbol}`;
  return `Order Submitted: ${side} ${symbol}`;
}

import { formatNotificationDisplay } from "./dashboard-ui";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export interface UnifiedActivitySubEvent {
  id: string;
  createdAt: string;
  type: "audit" | "notification" | "fill" | "order";
  title: string;
  detail: string;
  fullText?: string;
  status?: string;
  error?: string;
  raw?: unknown;
}

export interface UnifiedActivityGroup {
  id: string;
  proposalId?: string;
  createdAt: string;
  updatedAt: string;
  symbol?: string;
  side?: "buy" | "sell";
  companyName?: string;
  title: string;
  detail: string;
  fullText?: string;
  status: string;
  tags: string[];
  events: UnifiedActivitySubEvent[];
  connectedAccountId?: string;
  accountLabel?: string;
}

/** Source-level cap on the PROPOSAL-LESS unified-feed tail (fills with no proposal + notifications),
 *  which is render-only (client slices the rendered feed to 50). Proposal-bearing groups are never
 *  capped — the decision ledger reconciles their statuses for up to 100 recent proposals. */
export const UNIFIED_FEED_MAX_GROUPS = 60;

export function buildUnifiedFeed(input: {
  audit: SourceAuditEvent[];
  notifications: NotificationEvent[];
  fills: FillEvent[];
  orders: EquityOrder[];
  symbolMetaBySymbol: Record<string, SymbolMeta>;
  accountLabelById?: Record<string, string>;
  getProposalById?: (proposalId: string) => { proposal: TradeProposal } | undefined;
}): UnifiedActivityGroup[] {
  const symbolMetaBySymbol = input.symbolMetaBySymbol ?? {};
  const accountLabelById = input.accountLabelById ?? {};
  const proposalIdByOrderId: Record<string, string> = {};

  // Build mapping of order_id to proposal_id from fills
  for (const fill of input.fills) {
    if (fill.proposalId && fill.brokerOrderId) {
      proposalIdByOrderId[fill.brokerOrderId] = fill.proposalId;
    }
  }

  // Build mapping from audit events
  for (const event of input.audit) {
    if (event.kind === "proposal_approved") {
      const payload = asRecord(event.payload);
      const proposalId = stringValue(payload.proposalId);
      const orderId = stringValue(payload.orderId);
      if (proposalId && orderId) {
        proposalIdByOrderId[orderId] = proposalId;
      }
    }
  }

  const groupEvents: Record<string, UnifiedActivitySubEvent[]> = {};

  const addSubEvent = (groupId: string, subEvent: UnifiedActivitySubEvent) => {
    if (!groupEvents[groupId]) groupEvents[groupId] = [];
    groupEvents[groupId].push(subEvent);
  };

  const proposalIdByGroupId = new Map<string, string>();
  const symbolByGroupId = new Map<string, string>();
  const sideByGroupId = new Map<string, "buy" | "sell" | undefined>();
  const accountIdByGroupId = new Map<string, string>();

  // Helper to extract symbol and side from a proposal lookup
  const lookupProposalInfo = (proposalId: string) => {
    if (input.getProposalById) {
      const lookup = input.getProposalById(proposalId);
      if (lookup?.proposal) {
        return {
          symbol: normalizeSymbol(lookup.proposal.symbol),
          side: normalizeSide(lookup.proposal.side)
        };
      }
    }
    return {};
  };

  // 1. Process Audit Events
  for (const event of input.audit) {
    if (event.kind === "notification") {
      continue;
    }

    const payload = asRecord(event.payload);
    const proposalId = getProposalIdFromAudit(event);

    let symbol = normalizeSymbol(stringValue(payload.symbol));
    let side = normalizeSide(stringValue(payload.side));

    if (proposalId) {
      const pInfo = lookupProposalInfo(proposalId);
      if (pInfo.symbol) symbol = pInfo.symbol;
      if (pInfo.side) side = pInfo.side;
    }

    const companyName = symbol ? symbolMetaBySymbol[symbol]?.companyName : undefined;
    const feed = formatAuditEvent(event.kind, payload, { symbol, side, companyName });

    const subEvent: UnifiedActivitySubEvent = {
      id: event.id,
      createdAt: event.createdAt,
      type: "audit",
      title: feed.title,
      detail: feed.detail,
      fullText: feed.fullText ?? feed.detail,
      raw: { kind: event.kind }
    };

    // Run-scoped events (run completed / rationale diversity / candidates considered /
    // signal snapshot / llm steps) consolidate into ONE `run-<runId>` group instead of
    // one card each (#8). Everything else without a proposal stays its own group.
    const groupId = proposalId ? `prop-${proposalId}` : runGroupIdForAudit(event.kind, payload) ?? `audit-${event.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);
    if (event.connectedAccountId) accountIdByGroupId.set(groupId, event.connectedAccountId);

    addSubEvent(groupId, subEvent);
  }

  // 2. Process Notification Events
  for (const event of input.notifications) {
    const payload = asRecord(event.payload);
    const proposalId = getProposalIdFromNotification(event);

    const display = formatNotificationDisplay(event, symbolMetaBySymbol);

    let symbol = normalizeSymbol(display.symbol);
    let side = normalizeSide(stringValue(asRecord(payload.fill).side) ?? stringValue(asRecord(payload.proposal).side));

    if (proposalId) {
      const pInfo = lookupProposalInfo(proposalId);
      if (pInfo.symbol) symbol = pInfo.symbol;
      if (pInfo.side) side = pInfo.side;
    }

    const subEvent: UnifiedActivitySubEvent = {
      id: event.id,
      createdAt: event.createdAt,
      type: "notification",
      title: display.title,
      detail: display.detail,
      status: event.status,
      error: event.error,
      raw: event.payload
    };

    const groupId = proposalId ? `prop-${proposalId}` : `notif-${event.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);
    // Notifications are USER-wide rows: carry their account attribution onto the group so
    // another account's proposal/fill alerts can be filtered out of this account's feed (#10).
    if (event.connectedAccountId) accountIdByGroupId.set(groupId, event.connectedAccountId);

    addSubEvent(groupId, subEvent);
  }

  // 3. Process Fill Events
  for (const fill of input.fills) {
    const proposalId = fill.proposalId ?? undefined;
    const symbol = normalizeSymbol(fill.symbol);
    const side = normalizeSide(fill.side);

    const formattedQty = formatQuantity(fill.quantity, symbol);
    const subEvent: UnifiedActivitySubEvent = {
      id: fill.id,
      createdAt: fill.filledAt,
      type: "fill",
      title: `${fill.source === "paper" ? "Paper " : ""}${fill.side.toUpperCase()} ${fill.symbol}`,
      detail: fill.status === "pending_reconciliation"
        ? `${formattedQty} shares reviewed @ ${trimCurrency(fill.price)} · broker order pending execution`
        : `${formattedQty} shares @ ${trimCurrency(fill.price)} · ${fill.status}`,
      status: fill.status,
      raw: fill.raw
    };

    const groupId = proposalId ? `prop-${proposalId}` : `fill-${fill.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);

    addSubEvent(groupId, subEvent);
  }

  // 4. Process Broker Orders
  for (const order of input.orders) {
    const proposalId = proposalIdByOrderId[order.id];
    const symbol = normalizeSymbol(order.symbol);
    const side = normalizeSide(order.side);

    const formattedFilled = formatQuantity(order.filledQuantity, symbol);
    const formattedTotal = formatQuantity(order.quantity, symbol);
    const subEvent: UnifiedActivitySubEvent = {
      id: order.id,
      createdAt: order.createdAt,
      type: "order",
      title: brokerOrderTitle(order),
      detail: `Broker state: ${readableBrokerState(order.state)} · Qty ${formattedFilled} / ${formattedTotal} · ${order.type}`,
      status: order.state,
      raw: order
    };

    const groupId = proposalId ? `prop-${proposalId}` : `order-${order.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);

    addSubEvent(groupId, subEvent);
  }

  const unifiedGroups: UnifiedActivityGroup[] = [];

  for (const [groupId, events] of Object.entries(groupEvents)) {
    events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const earliestDate = events[0]!.createdAt;
    const latestDate = events[events.length - 1]!.createdAt;

    const proposalId = proposalIdByGroupId.get(groupId);
    const symbol = symbolByGroupId.get(groupId);
    const side = sideByGroupId.get(groupId);
    const companyName = symbol ? symbolMetaBySymbol[symbol]?.companyName : undefined;
    const connectedAccountId = accountIdByGroupId.get(groupId);
    const accountLabel = connectedAccountId ? accountLabelById[connectedAccountId] : undefined;

    const tagsSet = new Set<string>();
    for (const ev of events) {
      if (ev.type === "audit") {
        const rawAud = asRecord(ev.raw);
        const audKind = stringValue(rawAud.kind) ?? "";
        if (audKind === "policy_change" || audKind === "profile_change") {
          tagsSet.add("policy change");
        }
        if (audKind === "fill_reconciled") {
          tagsSet.add("trade");
        }
        if (audKind === "post_mortem_reflection") {
          tagsSet.add("post mortem");
        }
      }
      if (ev.type === "fill") {
        tagsSet.add("trade");
      }
      if (ev.type === "notification") {
        const nStatus = ev.status;
        if (nStatus === "sent") {
          tagsSet.add("notification sent");
        } else if (nStatus === "failed") {
          tagsSet.add("notification failed");
        } else if (nStatus === "skipped") {
          tagsSet.add("notification disabled");
        }
        const nRaw = asRecord(ev.raw);
        if (stringValue(nRaw.type) === "fill") {
          tagsSet.add("trade");
        }
      }
    }

    if (side === "buy") { tagsSet.add("buy"); tagsSet.add("trade"); }
    if (side === "sell") { tagsSet.add("sell"); tagsSet.add("trade"); }

    let status = "unknown";
    let title = "";
    let detail = "";

    if (proposalId) {
      const hasFill = events.find(ev => ev.type === "fill");
      const hasOrder = events.find(ev => ev.type === "order") as UnifiedActivitySubEvent | undefined;
      const hasApproval = events.find(ev => ev.type === "audit" && ev.title.includes("Approved"));
      const hasBrokerRejection = events.find(ev => ev.type === "audit" && asRecord(ev.raw).kind === "order_rejected_by_broker");
      const hasRejection = events.find(ev => ev.type === "audit" && ev.title.includes("Rejected"));
      const hasBlock = events.find(ev => ev.type === "notification" && ev.title.includes("Blocked"));
      const hasPendingApproval = events.find(ev => ev.type === "notification" && ev.title.includes("Approval Pending"));
      const order = hasOrder?.raw as EquityOrder | undefined;

      if (hasFill) {
        if (hasFill.status === "filled") {
          status = "filled";
        } else if (hasFill.status === "pending_reconciliation") {
          status = "pending_order";
        } else if (order?.state === "filled") {
          status = "filled";
        } else if (order?.state === "partially_filled") {
          status = "partially_filled";
        } else if (isTerminalBrokerState(order?.state)) {
          status = order!.state;
        } else if (isPendingBrokerState(order?.state) || hasFill.status === "pending_reconciliation") {
          status = "pending_order";
        } else {
          status = hasFill.status ?? "pending_order";
        }
      } else if (order?.state === "filled") {
        status = "filled";
      } else if (order?.state === "partially_filled") {
        status = "partially_filled";
      } else if (isTerminalBrokerState(order?.state)) {
        status = order!.state;
      } else if (isPendingBrokerState(order?.state)) {
        status = "pending_order";
      } else if (hasBrokerRejection) {
        status = "rejected";
      } else if (hasRejection) {
        status = "rejected";
      } else if (hasApproval) {
        status = "approved";
      } else if (hasBlock) {
        status = "blocked";
      } else if (hasPendingApproval) {
        status = "pending_approval";
      } else {
        status = "pending";
      }

      // An account is an account: a fill's own `source` ("paper"/"live", stamped at the FillEvent
      // level — see "Process Fill Events" above) is the sole signal for whether this group is a
      // broker-paper trade. It is never rewritten to "Test" — that execution mode no longer exists,
      // and broker-paper is not "the same as Test", it is a real broker-hosted sandbox account.
      const isPaper = events.some(ev => ev.type === "fill" && ev.title.startsWith("Paper "));

      // Group title mirrors the broker-style fill/order title casing (uppercase side),
      // distinct from the title-case used by individual notification/audit sub-events.
      const displaySide = side === "buy" ? "BUY" : side === "sell" ? "SELL" : "Trade";
      title = `${isPaper ? "Paper " : ""}${displaySide} ${symbol}`;

      if (status === "filled") {

        const fillEv = events.find(ev => ev.type === "fill" && ev.status === "filled")!;
        detail = fillEv.detail;
      } else if (status === "pending_reconciliation") {
        const fillEv = events.find(ev => ev.type === "fill")!;
        detail = `Pending Broker Order: ${fillEv.detail}`;
      } else if ((hasFill || hasOrder) && (status === "pending_order" || status === "partially_filled" || isTerminalBrokerState(status))) {
        detail = brokerOrderDetail(order, hasFill?.status);
      } else if (status === "rejected" && hasBrokerRejection) {
        detail = hasBrokerRejection.detail;
      } else if (status === "rejected") {
        detail = "Rejected manually";
      } else if (status === "approved") {
        const appEv = events.find(ev => ev.type === "audit" && ev.title.includes("Approved"))!;
        detail = appEv.detail;
      } else if (status === "blocked") {
        const blkEv = events.find(ev => ev.type === "notification" && ev.title.includes("Blocked"))!;
        detail = blkEv.detail;
      } else if (status === "pending_approval") {
        detail = "Awaiting Approval";
      } else {
        detail = events[0]!.detail;
      }
    } else if (groupId.startsWith("run-")) {
      // Consolidated strategy-run card (#8): the strategy_run event is the primary
      // (title + summary rendered ONCE); diversity/candidates/signal-snapshot rows
      // stay visible as sub-rows. Falls back to the first event if the run summary
      // audit aged out of the window.
      const primary = events.find(
        (ev) => ev.type === "audit" && stringValue(asRecord(ev.raw).kind) === "strategy_run"
      );
      const anchor = primary ?? events[0]!;
      title = anchor.title;
      detail = anchor.detail;
      status = primary ? (primary.title.toLowerCase().includes("failed") ? "failed" : "completed") : events[0]!.status ?? "completed";
    } else {
      title = events[0]!.title;
      detail = events[0]!.detail;
      status = events[0]!.status ?? "completed";
    }
    // Single-event groups surface the sub-event's fullText (e.g. an ops event's raw
    // JSON payload) so the client can offer a raw-data toggle; grouped cards keep the
    // summary as fullText.
    const groupFullText = proposalId || groupId.startsWith("run-") ? detail : events[0]!.fullText ?? detail;

    const tagsList = Array.from(tagsSet);
    const isPolicyUpdate = tagsList.includes("policy change") || title.includes("Policy updated") || title.includes("Profile");

    if (isPolicyUpdate) {
      if (!tagsList.includes("notification disabled")) {
        tagsList.push("notification disabled");
      }
      const failedIdx = tagsList.indexOf("notification failed");
      if (failedIdx !== -1) tagsList.splice(failedIdx, 1);
    } else {
      if (!tagsList.includes("notification failed")) {
        tagsList.push("notification failed");
      }
      const disabledIdx = tagsList.indexOf("notification disabled");
      if (disabledIdx !== -1) tagsList.splice(disabledIdx, 1);
    }

    // Force all events to have the 'paper' tag since Live is not tested yet.
    if (!tagsList.includes("paper")) {
      tagsList.push("paper");
    }

    unifiedGroups.push({
      id: groupId,
      proposalId,
      createdAt: earliestDate,
      updatedAt: latestDate,
      symbol,
      side,
      companyName,
      title,
      detail,
      fullText: groupFullText,
      status,
      tags: tagsList,
      events,
      connectedAccountId,
      accountLabel
    });
  }

  // Bound the shipped payload WITHOUT changing observable output. The client uses this feed two ways:
  // (1) it renders only the newest 50 (`feed.slice(0, 50)`), and (2) `decisionLedgerItems` reconciles
  // fill/order-derived statuses for up to 100 recent proposals from it. So we keep EVERY
  // proposal-bearing group (reconciliation must stay complete) and cap only the proposal-less tail
  // (fills without a proposal + notifications), which is render-only. Because any proposal-less group
  // in the newest 50 is necessarily within the newest 60 proposal-less groups, the rendered newest-50
  // is unchanged; only the far, render-invisible tail is trimmed.
  const sorted = unifiedGroups.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const withProposal = sorted.filter((g) => g.proposalId);
  const withoutProposal = sorted.filter((g) => !g.proposalId).slice(0, UNIFIED_FEED_MAX_GROUPS);
  return [...withProposal, ...withoutProposal].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getProposalIdFromAudit(event: SourceAuditEvent): string | undefined {
  const payload = asRecord(event.payload);
  const nested = asRecord(payload.payload);
  return (
    stringValue(payload.proposalId) ??
    stringValue(nested.proposalId)
  );
}

function getProposalIdFromNotification(event: NotificationEvent): string | undefined {
  const payload = asRecord(event.payload);
  const fill = asRecord(payload.fill);
  const proposal = asRecord(payload.proposal);
  return (
    stringValue(payload.proposalId) ??
    stringValue(fill.proposalId) ??
    stringValue(proposal.id) ??
    stringValue(proposal.proposalId)
  );
}
