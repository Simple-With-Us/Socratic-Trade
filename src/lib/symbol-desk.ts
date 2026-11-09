/**
 * Per-symbol desk facts for the ticker sheet (web drawer, iOS).
 *
 * Current-account lot economics stay on the existing snapshot.  This module
 * adds the pieces the snapshot does not carry into the sheet: the persisted
 * exit contract / take-profit ratchet, and a size+direction mention of the
 * same symbol on the user's OTHER connected accounts (never full P&L).
 */

import { normalizeSymbol } from "./money";
import type { ConnectedAccount, EquityPosition, PendingProposal, SocraticDecisionCase } from "./types";
import type { PositionStopPlan, TakeProfitTrimBand } from "./db-api-keys";

export type PeerAccountDirection = "long" | "short";

export type PeerAccountHolding = {
  accountId: string;
  label: string;
  environment?: string;
  direction: PeerAccountDirection;
  quantity: number;
  recordedAt?: string;
};

export type SymbolDeskExit = {
  style?: string;
  rationale?: string;
  stopPrice?: number;
  takeProfitPrice?: number;
  trailPercent?: number;
  resolvedStopPct?: number;
  invalidation?: string;
  maxHoldingUntil?: string;
  trimBand?: number;
};

export type SymbolDeskProposal = {
  id: string;
  side: string;
  quantity?: number;
  dollarAmount?: number;
  thesis?: string;
  rationale?: string;
  confidenceScore?: number;
  createdAt?: string;
};

export type SymbolDeskLastCall = {
  id: string;
  side?: string;
  status: string;
  green?: string;
  red?: string;
  outcome?: string;
};

export type SymbolDesk = {
  symbol: string;
  peerAccounts: PeerAccountHolding[];
  exit?: SymbolDeskExit;
  pending: SymbolDeskProposal[];
  lastCall?: SymbolDeskLastCall;
};

function clipLine(text: string | undefined, max = 200): string | undefined {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function compactLastCall(
  cases: SocraticDecisionCase[] | undefined,
  symbol: string
): SymbolDeskLastCall | undefined {
  const want = normalizeSymbol(symbol);
  const match = (cases ?? []).find((item) => normalizeSymbol(item.symbol ?? "") === want);
  if (!match) return undefined;
  const red = match.redTeamVerdict;
  const redLine = !red
    ? undefined
    : !red.available
      ? clipLine(red.reason ? `Red unavailable: ${red.reason}` : "Red unavailable")
      : clipLine(
          red.rejected
            ? `Red reject${red.reason ? `: ${red.reason}` : ""}`
            : red.verdict === "approve-at-half"
              ? `Red half-size${red.reason ? `: ${red.reason}` : ""}`
              : `Red approve${red.reason ? `: ${red.reason}` : ""}`
        );
  const green = clipLine(match.greenTeamRationale || match.thesis || match.rationale);
  return {
    id: match.id,
    ...(match.side ? { side: match.side } : {}),
    status: match.status,
    ...(green ? { green } : {}),
    ...(redLine ? { red: redLine } : {}),
    ...(match.outcome?.status ? { outcome: match.outcome.status } : {})
  };
}

export function signedQuantityToDirection(quantity: number): PeerAccountDirection | undefined {
  if (!Number.isFinite(quantity) || quantity === 0) return undefined;
  return quantity < 0 ? "short" : "long";
}

export function findHeldLot(positions: EquityPosition[] | undefined, symbol: string): EquityPosition | undefined {
  const want = normalizeSymbol(symbol);
  if (!want) return undefined;
  return (positions ?? []).find((p) => normalizeSymbol(p.symbol) === want && Number.isFinite(p.quantity) && p.quantity !== 0);
}

export function peerHoldingFromLot(
  account: Pick<ConnectedAccount, "id" | "label" | "environment">,
  lot: EquityPosition,
  recordedAt?: string
): PeerAccountHolding | undefined {
  const direction = signedQuantityToDirection(lot.quantity);
  if (!direction) return undefined;
  return {
    accountId: account.id,
    label: (account.label || "Account").trim() || "Account",
    environment: account.environment,
    direction,
    quantity: Math.abs(lot.quantity),
    ...(recordedAt ? { recordedAt } : {})
  };
}

export function collectPeerHoldings(input: {
  symbol: string;
  currentAccountNumber?: string;
  accounts: ConnectedAccount[];
  latestPositions: (accountNumber: string) => { positions: EquityPosition[]; recordedAt?: string } | undefined;
}): PeerAccountHolding[] {
  const current = (input.currentAccountNumber ?? "").trim();
  const out: PeerAccountHolding[] = [];
  for (const account of input.accounts) {
    const number = (account.accountNumber ?? "").trim();
    if (!number || (current && number === current)) continue;
    const snap = input.latestPositions(number);
    const lot = findHeldLot(snap?.positions, input.symbol);
    if (!lot) continue;
    const peer = peerHoldingFromLot(account, lot, snap?.recordedAt);
    if (peer) out.push(peer);
  }
  return out;
}

export function compactExit(
  plan: PositionStopPlan | undefined,
  trim: TakeProfitTrimBand | undefined
): SymbolDeskExit | undefined {
  if (!plan && !trim) return undefined;
  const exit: SymbolDeskExit = {};
  if (plan) {
    if (plan.style && plan.style !== "default") exit.style = plan.style;
    if (plan.rationale) exit.rationale = plan.rationale;
    if (typeof plan.stopPrice === "number" && plan.stopPrice > 0) exit.stopPrice = plan.stopPrice;
    if (typeof plan.takeProfitPrice === "number" && plan.takeProfitPrice > 0) {
      exit.takeProfitPrice = plan.takeProfitPrice;
    }
    if (typeof plan.trailPercent === "number" && plan.trailPercent > 0) exit.trailPercent = plan.trailPercent;
    if (typeof plan.resolvedStopPct === "number" && plan.resolvedStopPct > 0) {
      exit.resolvedStopPct = plan.resolvedStopPct;
    }
    if (plan.invalidation) exit.invalidation = plan.invalidation;
    if (plan.maxHoldingUntil) exit.maxHoldingUntil = plan.maxHoldingUntil;
  }
  if (trim && Number.isFinite(trim.band) && trim.band > 0) exit.trimBand = trim.band;
  return Object.keys(exit).length > 0 ? exit : undefined;
}

export function compactPending(items: PendingProposal[], symbol: string): SymbolDeskProposal[] {
  const want = normalizeSymbol(symbol);
  return items
    .filter((item) => normalizeSymbol(item.proposal.symbol) === want)
    .slice(0, 6)
    .map((item) => ({
      id: item.id,
      side: item.proposal.side,
      ...(typeof item.proposal.quantity === "number" ? { quantity: item.proposal.quantity } : {}),
      ...(typeof item.proposal.dollarAmount === "number" ? { dollarAmount: item.proposal.dollarAmount } : {}),
      ...(item.proposal.tradeThesisTag ? { thesis: item.proposal.tradeThesisTag } : {}),
      ...(item.proposal.rationale ? { rationale: item.proposal.rationale } : {}),
      ...(typeof item.proposal.confidenceScore === "number"
        ? { confidenceScore: item.proposal.confidenceScore }
        : {}),
      ...(item.createdAt ? { createdAt: item.createdAt } : {})
    }));
}

export function buildSymbolDesk(input: {
  symbol: string;
  currentAccountNumber?: string;
  accounts: ConnectedAccount[];
  latestPositions: (accountNumber: string) => { positions: EquityPosition[]; recordedAt?: string } | undefined;
  stopPlan?: PositionStopPlan;
  trim?: TakeProfitTrimBand;
  pending: PendingProposal[];
  cases?: SocraticDecisionCase[];
}): SymbolDesk {
  const symbol = normalizeSymbol(input.symbol);
  return {
    symbol,
    peerAccounts: collectPeerHoldings({
      symbol,
      currentAccountNumber: input.currentAccountNumber,
      accounts: input.accounts,
      latestPositions: input.latestPositions
    }),
    exit: compactExit(input.stopPlan, input.trim),
    pending: compactPending(input.pending, symbol),
    lastCall: compactLastCall(input.cases, symbol)
  };
}
