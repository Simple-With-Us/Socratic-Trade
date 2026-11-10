"use client";

/** Section components for the console symbol drilldown. Pure presentation over
 *  the helpers in drilldown-data.ts — every value is real or an em dash, every
 *  tile/label/chip carries a plain-language tooltip, and each list row opts
 *  into the console's hover highlight via .con-row. */

import Link from "next/link";
import { type ReactNode } from "react";
import type { EquityOrder, EquityPosition, PendingProposal } from "@/lib/types";
import type { PeerAccountHolding, SymbolDeskExit, SymbolDeskLastCall } from "@/lib/symbol-desk";
import { type ProtectionInfo } from "../lib/derive";
import { friendlySource, orderedSourceEntries, provenanceLabel } from "@/lib/dashboard-ui";
import { cx, fmtMoney, fmtPct, fmtQty, EM_DASH } from "../lib/format";
import { plainLabel, thesisTagLabel } from "../lib/labels";
import { readableState } from "../orders/lib";
import { Ago, Chip, Dash, SignedText, Tooltip, type ChipTone } from "./primitives";
import {
  buildDerivedTiles,
  buildSignalChips,
  buildSignalSummary,
  factorRows,
  fmtCompact,
  normalizedDebtToEquity,
  peDisplay,
  positionEconomics,
  ratingDistribution,
  ratingTooltip,
  targetUpsidePct,
  withProvenance,
  isStaleViewField,
  type DerivedResult,
  type QuoteView
} from "./drilldown-data";

// ── Shared shells ────────────────────────────────────────────────────────────

/** Bordered section block with an uppercase title (tooltip on the title). */
function Section({ title, titleHint, children }: { title: string; titleHint: string; children: ReactNode }) {
  return (
    <section className="rounded-control border border-[color:var(--con-line)] p-3">
      <h3 className="con-card-title mb-2 cursor-default">
        <Tooltip content={titleHint}>{title}</Tooltip>
      </h3>
      {children}
    </section>
  );
}

/** Collapsible section for the deep-dive tail of the drawer. */
function Disclosure({ title, titleHint, children, defaultOpen }: { title: string; titleHint: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="con-disclosure rounded-control border border-[color:var(--con-line)] px-3" open={defaultOpen}>
      <summary><Tooltip content={titleHint}>{title}</Tooltip></summary>
      <div className="pb-3">{children}</div>
    </details>
  );
}

// ── Your exposure ────────────────────────────────────────────────────────────

const SIDE_TONE: Record<string, ChipTone> = { buy: "pos", cover: "pos", sell: "neg", short: "neg" };

function sideChip(side: string) {
  return (
    <Chip tone={SIDE_TONE[side] ?? "muted"} title={`Proposed order side: ${side}`}>
      {side.toUpperCase()}
    </Chip>
  );
}

export function ExitPlanSection({
  symbol,
  protection,
  exit
}: {
  symbol: string;
  protection: ProtectionInfo;
  exit?: SymbolDeskExit;
}) {
  const hasNumbers =
    typeof exit?.stopPrice === "number" ||
    typeof exit?.takeProfitPrice === "number" ||
    typeof exit?.trailPercent === "number" ||
    typeof exit?.resolvedStopPct === "number" ||
    typeof exit?.trimBand === "number";
  return (
    <Section
      title="Exit plan"
      titleHint={`How this account currently plans to cut a loss or harvest profit in ${symbol}: a resting broker stop, an app-managed stop or trail, staged take-profit trims, and any kill condition written at entry.`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {protection.label ? (
          <Chip tone={protection.tone === "pos" ? "pos" : protection.tone === "warn" ? "warn" : "muted"}>
            {protection.label}
          </Chip>
        ) : (
          <Chip tone="muted">No stop armed</Chip>
        )}
        {typeof exit?.trimBand === "number" && exit.trimBand > 0 && (
          <Chip tone="accent" title="How many take-profit bands have already been harvested on this lot.">
            Trim band {exit.trimBand} done
          </Chip>
        )}
      </div>
      <p className="mt-2 text-[length:var(--con-fs-sm)] leading-snug text-[color:var(--con-ink)]">
        {protection.detail}
      </p>
      {hasNumbers && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {typeof exit?.stopPrice === "number" && (
            <div>
              <div className="con-card-title mb-0.5">Stop</div>
              <div className="con-num text-[length:var(--con-fs-sm)]">{fmtMoney(exit.stopPrice)}</div>
            </div>
          )}
          {typeof exit?.takeProfitPrice === "number" && (
            <div>
              <div className="con-card-title mb-0.5">Take profit</div>
              <div className="con-num text-[length:var(--con-fs-sm)]">{fmtMoney(exit.takeProfitPrice)}</div>
            </div>
          )}
          {typeof exit?.trailPercent === "number" && (
            <div>
              <div className="con-card-title mb-0.5">Trail</div>
              <div className="con-num text-[length:var(--con-fs-sm)]">{fmtPct(exit.trailPercent, 1, false)}</div>
            </div>
          )}
          {typeof exit?.resolvedStopPct === "number" && (
            <div>
              <div className="con-card-title mb-0.5">Stop distance</div>
              <div className="con-num text-[length:var(--con-fs-sm)]">{fmtPct(exit.resolvedStopPct, 1, false)}</div>
            </div>
          )}
        </div>
      )}
      {exit?.invalidation && (
        <p className="mt-2 text-[length:var(--con-fs-sm)] leading-snug text-[color:var(--con-faint)]">
          Kill condition: {exit.invalidation}
        </p>
      )}
      {exit?.rationale && (
        <p className="mt-1 text-[length:var(--con-fs-sm)] leading-snug text-[color:var(--con-faint)]">
          Why this plan: {exit.rationale}
        </p>
      )}
      {exit?.maxHoldingUntil && (
        <p className="mt-1 text-[length:var(--con-fs-sm)] leading-snug text-[color:var(--con-faint)]">
          Time stop after {exit.maxHoldingUntil.slice(0, 10)}.
        </p>
      )}
    </Section>
  );
}

export function PeerAccountsSection({
  symbol,
  peers,
  onSwitch
}: {
  symbol: string;
  peers: PeerAccountHolding[];
  onSwitch?: (accountId: string) => void;
}) {
  if (peers.length === 0) return null;
  return (
    <Section
      title="Other accounts"
      titleHint={`Same owner, different account.  Only size and direction — open that account to see cost, P&amp;L, and the full exit plan.`}
    >
      <ul className="flex flex-col">
        {peers.map((peer) => (
          <li key={peer.accountId} className="con-row -mx-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded px-1 py-1.5 text-[length:var(--con-fs-sm)]">
            <Chip tone={peer.direction === "short" ? "neg" : "pos"}>
              {peer.direction === "short" ? "Short" : "Long"}
            </Chip>
            <span className="con-num">{fmtQty(peer.quantity)} sh</span>
            <span className="text-[color:var(--con-ink)]">{peer.label}</span>
            {peer.environment && (
              <span className="text-[color:var(--con-faint)]">{peer.environment}</span>
            )}
            {onSwitch && (
              <button
                type="button"
                className="ml-auto font-semibold text-[color:var(--con-accent)] hover:underline"
                onClick={() => onSwitch(peer.accountId)}
              >
                Use this account
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
        Last recorded lot on another account of yours — not a live broker refresh.  Switching loads that account&apos;s full book.
      </p>
    </Section>
  );
}

export function LastCallSection({ lastCall }: { lastCall?: SymbolDeskLastCall }) {
  if (!lastCall) return null;
  return (
    <Section
      title="Last desk call"
      titleHint="The latest Green/Red decision case for this ticker on this account.  Full evidence stays on the decision page."
    >
      <div className="flex flex-wrap items-center gap-2">
        {lastCall.side && <Chip tone={lastCall.side === "buy" || lastCall.side === "cover" ? "pos" : "neg"}>{lastCall.side}</Chip>}
        <Chip tone="muted">{lastCall.status.replace(/_/g, " ")}</Chip>
        {lastCall.outcome && lastCall.outcome !== "open" && lastCall.outcome !== "unknown" && (
          <Chip tone={lastCall.outcome === "won" ? "pos" : lastCall.outcome === "lost" ? "neg" : "muted"}>
            {lastCall.outcome}
          </Chip>
        )}
      </div>
      {lastCall.green && (
        <p className="mt-2 text-[length:var(--con-fs-sm)] leading-snug">Green: {lastCall.green}</p>
      )}
      {lastCall.red && (
        <p className="mt-1 text-[length:var(--con-fs-sm)] leading-snug text-[color:var(--con-faint)]">
          {lastCall.red}
        </p>
      )}
      <Link
        href={`/console/decisions/${encodeURIComponent(lastCall.id)}`}
        className="mt-2 inline-block font-semibold text-[color:var(--con-accent)] hover:underline"
      >
        Open decision
      </Link>
    </Section>
  );
}

export function ExposureSection({
  symbol,
  position,
  pending,
  orders
}: {
  symbol: string;
  position?: EquityPosition;
  pending: PendingProposal[];
  orders: EquityOrder[];
}) {
  const econ = position ? positionEconomics(position) : null;
  const empty = !position && pending.length === 0 && orders.length === 0;

  return (
    <Section
      title="Your exposure"
      titleHint={`Everything this account has going on in ${symbol}: the current position, trade ideas waiting for approval, and recent orders.`}
    >
      {empty && (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
          No position, no pending trade ideas, and no recent orders in {symbol} on this account.
        </p>
      )}

      {position && econ && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tooltip className="cursor-default flex flex-col" content={`Shares currently held${econ.isShort ? " (negative = short position)" : ""}.`}>
            <div className="con-card-title mb-0.5">Quantity</div>
            <div className="con-num text-[length:var(--con-fs-sm)]">
              {fmtQty(position.quantity)} sh{econ.isShort ? " · short" : ""}
            </div>
          </Tooltip>
          <Tooltip className="cursor-default flex flex-col" content="What the position is worth at the latest known price.">
            <div className="con-card-title mb-0.5">Market value</div>
            <div className="con-num text-[length:var(--con-fs-sm)]">{fmtMoney(position.marketValue)}</div>
          </Tooltip>
          <Tooltip className="cursor-default flex flex-col" content={`Average cost per share (${fmtMoney(position.averageCost)}) × quantity — what was paid to build the position.`}>
            <div className="con-card-title mb-0.5">Entry basis</div>
            <div className="con-num text-[length:var(--con-fs-sm)]">
              {fmtMoney(econ.costBasis)}
              <span className="text-[color:var(--con-faint)]"> @ {fmtMoney(position.averageCost)}</span>
            </div>
          </Tooltip>
          <Tooltip
            className="cursor-default flex flex-col"
            content="Market value minus entry basis — the open gain or loss if closed at the latest known price.  Not realized until sold."
          >
            <div className="con-card-title mb-0.5">Unrealized P&L</div>
            <div className="text-[length:var(--con-fs-sm)]">
              <SignedText value={econ.pnl}>
                {fmtMoney(econ.pnl)}
                {typeof econ.returnPct === "number" ? ` (${fmtPct(econ.returnPct, 1, true)})` : ""}
              </SignedText>
            </div>
          </Tooltip>
        </div>
      )}

      {pending.length > 0 && (
        <div className={cx(position && "mt-3 border-t border-[color:var(--con-line)] pt-3")}>
          <div className="con-card-title mb-1.5">
            <Tooltip content="Trade ideas for this symbol waiting for your approval.  Nothing happens until you approve or reject them.">Waiting for you</Tooltip>
          </div>
          <ul className="flex flex-col">
            {pending.map((p) => (
              <li key={p.id}>
              <Tooltip
                className="con-row -mx-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded px-1 py-1.5 text-[length:var(--con-fs-sm)] w-full"
                content={p.proposal.rationale || "No rationale recorded."}
              >
                {sideChip(p.proposal.side)}
                <span className="con-num">
                  {typeof p.proposal.quantity === "number"
                    ? `${fmtQty(p.proposal.quantity)} sh`
                    : typeof p.proposal.dollarAmount === "number"
                      ? fmtMoney(p.proposal.dollarAmount)
                      : EM_DASH}
                </span>
                {p.proposal.tradeThesisTag && (
                  <Chip tone="muted" title="The thesis tag the strategy filed this idea under.">
                    {thesisTagLabel(p.proposal.tradeThesisTag)}
                  </Chip>
                )}
                {typeof p.proposal.confidenceScore === "number" && (
                  <Tooltip className="con-num text-[color:var(--con-faint)]" content="The strategy's stated conviction in this idea (0–100).">
                    conf {Math.round(p.proposal.confidenceScore)}
                  </Tooltip>
                )}
                <span className="text-[color:var(--con-faint)]">
                  <Ago iso={p.createdAt} />
                </span>
                <Link
                  href="/console/approvals"
                  className="ml-auto font-semibold text-[color:var(--con-accent)] hover:underline"
                >
                  <Tooltip content="Open the Approvals screen to approve or reject this idea.">Review →</Tooltip>
                </Link>
              </Tooltip>
              </li>
            ))}
          </ul>
        </div>
      )}

      {orders.length > 0 && (
        <div className={cx((position || pending.length > 0) && "mt-3 border-t border-[color:var(--con-line)] pt-3")}>
          <div className="con-card-title mb-1.5">
            <Tooltip content="The most recent orders this account has placed in this symbol, newest first.">Recent orders</Tooltip>
          </div>
          <ul className="flex flex-col">
            {orders.map((o) => (
              <li key={o.id}>
              <Tooltip
                className="con-row -mx-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded px-1 py-1.5 text-[length:var(--con-fs-sm)] w-full"
                content={`${o.side} ${o.type.replace(/_/g, " ")} order · state: ${readableState(o.state)}${o.placedAgent ? ` · placed by ${plainLabel(o.placedAgent)}` : ""}`}
              >
                {sideChip(o.side)}
                <span className="con-num">
                  {typeof o.filledQuantity === "number" && o.filledQuantity > 0
                    ? `${fmtQty(o.filledQuantity)} sh`
                    : typeof o.quantity === "number"
                      ? `${fmtQty(o.quantity)} sh`
                      : typeof o.dollarAmount === "number"
                        ? fmtMoney(o.dollarAmount)
                        : EM_DASH}
                  {typeof o.averagePrice === "number" && o.averagePrice > 0 ? ` @ ${fmtMoney(o.averagePrice)}` : ""}
                </span>
                <Chip tone={o.state === "filled" ? "pos" : ["cancelled", "canceled", "rejected", "failed", "expired"].includes(o.state) ? "neg" : "muted"} title={`Order state reported by the broker: ${readableState(o.state)}.`}>
                  {readableState(o.state)}
                </Chip>
                <span className="ml-auto text-[color:var(--con-faint)]">
                  <Ago iso={o.createdAt} />
                </span>
              </Tooltip>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

// ── Signal summary (pros / cons + signal chips) ──────────────────────────────

export function SignalSummarySection({ view, derived }: { view: QuoteView; derived: DerivedResult }) {
  const { pros, cons } = buildSignalSummary(view, derived.metrics);
  const chips = buildSignalChips(view);

  return (
    <Section
      title="Signal summary"
      titleHint="A plain-language readout of the strongest bullish and bearish signals in the last scan's data for this symbol — the same thresholds the legacy dashboard used."
    >
      {chips.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <Chip key={c.key} tone={c.tone} title={c.title}>
              {c.label}
            </Chip>
          ))}
        </div>
      )}
      {pros.length === 0 && cons.length === 0 ? (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
          No strong bullish or bearish signals in the last scan's data for this symbol.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {pros.length > 0 && (
            <ul className="space-y-1">
              {pros.map((p, i) => (
                <li key={i} className="flex gap-2 text-[length:var(--con-fs-sm)] leading-snug" style={{ color: "var(--con-pos)" }}>
                  <span className="shrink-0 font-bold">+</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
          {cons.length > 0 && (
            <ul className="space-y-1">
              {cons.map((c, i) => (
                <li key={i} className="flex gap-2 text-[length:var(--con-fs-sm)] leading-snug" style={{ color: "var(--con-neg)" }}>
                  <span className="shrink-0 font-bold">−</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

// ── Derived metric tiles ─────────────────────────────────────────────────────

export function DerivedTilesSection({ view, derived }: { view: QuoteView; derived: DerivedResult }) {
  const tiles = buildDerivedTiles(view, derived);
  return (
    <Section
      title="Derived metrics"
      titleHint="Ratios this app computes from the raw quote data it already pulls — the same values handed to the trading agent.  Hover any tile for what it means and how to read it."
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {tiles.map((t) => (
          <Tooltip key={t.key} className="con-tile cursor-default flex flex-col" content={t.title}>
            <div className="con-card-title">{t.label}</div>
            <div
              className="con-num mt-0.5 text-[length:var(--con-fs-md)] font-semibold"
              style={t.tone ? { color: t.tone === "pos" ? "var(--con-pos)" : "var(--con-neg)" } : undefined}
            >
              {t.value ?? <Dash />}
            </div>
          </Tooltip>
        ))}
      </div>
    </Section>
  );
}

// ── Factor breakdown ─────────────────────────────────────────────────────────

export function FactorSection({ view }: { view: QuoteView }) {
  const fb = view.factorBreakdown;
  if (!fb) return null;
  const rows = factorRows(fb);
  if (rows.length === 0) return null;
  return (
    <Section
      title="Factor breakdown"
      titleHint="Every weighted sub-score (0–100 each) behind this symbol's composite scan score.  The composite is the policy-weighted total the screener ranked by."
    >
      <div className="space-y-2">
        {rows.map((f) => (
          <Tooltip key={f.key} className="con-row -mx-1 cursor-default rounded px-1 py-0.5 flex flex-col w-full" content={f.title}>
            <div className="mb-0.5 flex items-baseline justify-between text-[length:var(--con-fs-xs)]">
              <span className="text-[color:var(--con-faint)]">{f.label}</span>
              <span className="con-num font-semibold">{f.value.toFixed(1)}</span>
            </div>
            <div className="con-score-bar">
              <div style={{ width: `${Math.max(0, Math.min(100, f.value))}%` }} />
            </div>
          </Tooltip>
        ))}
        <Tooltip
          className="flex items-baseline justify-between border-t border-[color:var(--con-line)] pt-2 text-[length:var(--con-fs-sm)] font-semibold w-full"
          content="The weighted total of all factor sub-scores using the active policy's scoring weights — the number the screener ranked this symbol by."
        >
          <span>Composite score</span>
          <span className="con-num">{typeof view.score === "number" ? view.score.toFixed(1) : EM_DASH}</span>
        </Tooltip>
      </div>
    </Section>
  );
}

// ── Analyst view (rating distribution + price-target range) ──────────────────

export function AnalystSection({ view }: { view: QuoteView }) {
  const dist = ratingDistribution(view);
  const hasTargets = typeof view.targetLow === "number" && typeof view.targetHigh === "number" && view.targetHigh > view.targetLow;
  const upside = targetUpsidePct(view);
  if (typeof view.analystScore !== "number" && !view.analystRating && !dist && !hasTargets && upside === undefined) return null;

  const price = view.price;
  // Range-bar domain spans the target band AND the current price so the price
  // marker never clips off the edge.
  const domainLow = hasTargets ? Math.min(view.targetLow!, price ?? view.targetLow!) : 0;
  const domainHigh = hasTargets ? Math.max(view.targetHigh!, price ?? view.targetHigh!) : 1;
  const span = domainHigh - domainLow || 1;
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - domainLow) / span) * 100));

  const DIST_SEGMENTS = dist
    ? ([
        { key: "strongBuy", label: "Strong Buy", value: dist.counts.strongBuy, color: "var(--con-pos)" },
        { key: "buy", label: "Buy", value: dist.counts.buy, color: "color-mix(in oklab, var(--con-pos) 55%, transparent)" },
        { key: "hold", label: "Hold", value: dist.counts.hold, color: "var(--con-surface-3)" },
        { key: "sell", label: "Sell", value: dist.counts.sell, color: "color-mix(in oklab, var(--con-neg) 55%, transparent)" },
        { key: "strongSell", label: "Strong Sell", value: dist.counts.strongSell, color: "var(--con-neg)" }
      ] as const)
    : [];

  return (
    <Section
      title="Analysts"
      titleHint="Wall Street analyst ratings and price targets for this symbol, as reported by the scan's data providers."
    >
      <div className="flex flex-col gap-3">
        {(typeof view.analystScore === "number" || view.analystRating) && (
          <div className="flex flex-wrap items-center gap-2 cursor-default" title={withProvenance(ratingTooltip(view), view, "analystRating")}>
            <span className="text-[length:var(--con-fs-sm)] font-semibold">{view.analystRating ?? EM_DASH}</span>
            {typeof view.analystScore === "number" && (
              <span className="con-num text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">blended {Math.round(view.analystScore)}/100</span>
            )}
          </div>
        )}

        {dist && (
          <div className="cursor-default" title={`${ratingTooltip(view)}\nDistribution shown from ${friendlySource(dist.source)} (${dist.total} analysts).`}>
            <div className="con-dist-bar" role="img" aria-label={`Analyst distribution across ${dist.total} analysts`}>
              {DIST_SEGMENTS.filter((s) => s.value > 0).map((s) => (
                <div key={s.key} style={{ width: `${(s.value / dist.total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value} of ${dist.total} analysts`} />
              ))}
            </div>
            <div className="con-num mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {DIST_SEGMENTS.map((s) => `${s.value} ${s.label}`).join(" · ")}
            </div>
          </div>
        )}

        {hasTargets && (
          <div
            className="cursor-default"
            title={withProvenance(
              `Analyst 12-month price targets: low ${fmtMoney(view.targetLow)}, ${typeof view.targetMedian === "number" ? `median ${fmtMoney(view.targetMedian)}, ` : ""}${typeof view.targetMean === "number" ? `mean ${fmtMoney(view.targetMean)}, ` : ""}high ${fmtMoney(view.targetHigh)}.  The marker is the current price — left of the mean implies analysts expect upside.`,
              view,
              "targetMean"
            )}
          >
            <div className="con-card-title mb-1">Price targets vs current</div>
            <div className="con-range-bar">
              <div
                className="con-range-fill"
                style={{ left: `${pct(view.targetLow!)}%`, width: `${Math.max(0, pct(view.targetHigh!) - pct(view.targetLow!))}%` }}
              />
              {typeof view.targetMean === "number" && (
                <div className="con-range-marker" style={{ left: `${pct(view.targetMean)}%`, background: "var(--con-accent)" }} title={`Mean target ${fmtMoney(view.targetMean)}`} />
              )}
              {typeof price === "number" && (
                <div className="con-range-marker" style={{ left: `${pct(price)}%`, background: "var(--con-fg)" }} title={`Current price ${fmtMoney(price)}`} />
              )}
            </div>
            <div className="con-num mt-1 flex justify-between text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              <span>low {fmtMoney(view.targetLow)}</span>
              {typeof upside === "number" && (
                <span style={{ color: upside >= 0 ? "var(--con-pos)" : "var(--con-neg)" }}>
                  {fmtPct(upside, 1, true)} to {typeof view.targetMean === "number" ? "mean" : "median"}
                </span>
              )}
              <span>high {fmtMoney(view.targetHigh)}</span>
            </div>
          </div>
        )}

        {!hasTargets && typeof upside === "number" && (
          <p className="text-[length:var(--con-fs-sm)] cursor-default" title={withProvenance("Consensus analyst price target vs the current price.", view, "targetMean")}>
            Consensus target {fmtMoney(view.targetMean ?? view.targetMedian)}{" "}
            <span style={{ color: upside >= 0 ? "var(--con-pos)" : "var(--con-neg)" }}>({fmtPct(upside, 1, true)} vs current)</span>
          </p>
        )}
      </div>
    </Section>
  );
}

// ── Deep fundamentals (collapsible key/value rows) ───────────────────────────

interface FundRow {
  key: string;
  label: string;
  value: ReactNode | null;
  title: string;
  /** True when the value is a computed "n/a" (real state), not missing data. */
  na?: boolean;
  /** True when the underlying observation is older than 24 hours. */
  stale?: boolean;
}

export function FundamentalsSection({ view }: { view: QuoteView }) {
  const pe = peDisplay(view.peRatio, view.eps);
  const de = normalizedDebtToEquity(view);
  const rows: FundRow[] = [
    {
      key: "peRatio",
      label: "P/E ratio",
      value: pe ? pe.text : null,
      na: pe?.na,
      stale: isStaleViewField(view, "peRatio"),
      title: withProvenance(
        pe?.na
          ? "Price ÷ trailing earnings per share. n/a because trailing earnings are negative or zero — the ratio genuinely doesn't exist, which is different from missing data."
          : "Price ÷ trailing earnings per share.  Under ~15 is traditionally cheap; over ~50 prices in a lot of growth.",
        view,
        "peRatio"
      )
    },
    {
      key: "eps",
      label: "EPS (ttm)",
      value: typeof view.eps === "number" ? fmtMoney(view.eps) : null,
      stale: isStaleViewField(view, "eps"),
      title: withProvenance("Trailing-twelve-month earnings per share.  Negative = the company lost money over the last year.", view, "eps")
    },
    {
      key: "epsGrowth",
      label: "EPS growth (YoY)",
      value: typeof view.epsGrowth === "number" ? fmtPct(view.epsGrowth * 100, 0, true) : null,
      stale: isStaleViewField(view, "epsGrowth"),
      title: withProvenance("Year-over-year earnings-per-share growth.  Positive and rising is the healthy pattern.", view, "epsGrowth")
    },
    {
      key: "pbRatio",
      label: "P/B ratio",
      value: typeof view.pbRatio === "number" ? view.pbRatio.toFixed(2) : null,
      stale: isStaleViewField(view, "pbRatio"),
      title: "Price ÷ book value per share.  Under 1 = trading below accounting net worth; capital-light businesses normally trade far above 1."
    },
    {
      key: "dividendYield",
      label: "Dividend yield",
      value: typeof view.dividendYield === "number" ? fmtPct(view.dividendYield, 2) : null,
      stale: isStaleViewField(view, "dividendYield"),
      title: withProvenance("Annual dividends ÷ price. 0 or missing simply means the company doesn't pay one.", view, "dividendYield")
    },
    {
      key: "fcfYield",
      label: "FCF yield",
      value: typeof view.fcfYield === "number" ? fmtPct(view.fcfYield, 1) : null,
      stale: isStaleViewField(view, "fcfYield"),
      title: withProvenance("Free cash flow ÷ market cap — cash actually generated per dollar of company value. 6%+ is strong; negative means the business burns cash.", view, "fcfYield")
    },
    {
      key: "debtToEquity",
      label: "Debt / equity",
      value: typeof de === "number" ? de.toFixed(2) : null,
      stale: isStaleViewField(view, "debtToEquity"),
      title: withProvenance("Total debt ÷ shareholder equity, normalized to a ratio.  Under 0.5 = conservatively financed; over 3 = heavily leveraged.", view, "debtToEquity")
    },
    {
      key: "beta",
      label: "Beta",
      value: typeof view.beta === "number" ? view.beta.toFixed(2) : null,
      title: "Sensitivity to market moves: 1 = moves with the market, above 1 = amplifies it, below 1 = steadier than the market."
    },
    {
      key: "shortPct",
      label: "Short % of float",
      value: typeof view.shortPercentOfFloat === "number" ? fmtPct(view.shortPercentOfFloat, 1) : null,
      title: "Share of freely tradable shares sold short. 20%+ is heavily shorted — bearish consensus, but also squeeze fuel."
    },
    {
      key: "instOwn",
      label: "Institutional ownership",
      value: typeof view.institutionOwnershipPct === "number" ? fmtPct(view.institutionOwnershipPct, 1) : null,
      title: "Percentage of shares held by institutions (funds, pensions).  High ownership = professional validation but less retail float."
    },
    {
      key: "iv",
      label: "Near-the-money IV",
      value: typeof view.nearTheMoneyIv === "number" ? fmtPct(view.nearTheMoneyIv, 1) : null,
      title: "Implied volatility of near-the-money options — the market's priced-in expectation of movement.  Higher = bigger expected swings."
    },
    {
      key: "putCall",
      label: "Put/call ratio",
      value: typeof view.putCallRatio === "number" ? view.putCallRatio.toFixed(2) : null,
      title: "Put open interest ÷ call open interest around the money.  Above 1 = more downside hedging/bets; below 1 = call-heavy optimism."
    },
    {
      key: "vwap",
      label: "VWAP",
      value: typeof view.vwap === "number" ? fmtMoney(view.vwap) : null,
      title: withProvenance("Volume-weighted average price of the latest session.  Price above VWAP = buyers paid up today; below = sellers dominated.", view, "vwap")
    },
    {
      key: "bidAsk",
      label: "Bid / ask",
      value: typeof view.bid === "number" && typeof view.ask === "number" ? `${fmtMoney(view.bid)} / ${fmtMoney(view.ask)}` : null,
      title: withProvenance("The best quoted buy (bid) and sell (ask) prices from the last scan.  The gap between them is the spread you pay to trade immediately.", view, "bid")
    },
    {
      key: "marketCap",
      label: "Market cap",
      value: fmtCompact(view.marketCap) ? `$${fmtCompact(view.marketCap)}` : null,
      title: "Total value of all shares (price × shares outstanding).  Over $10B = large cap; under $2B = small cap territory."
    },
    {
      key: "volume",
      label: "Share volume",
      value: fmtCompact(view.volume),
      title: withProvenance("Shares traded in the latest session.  Compare with the stock's normal volume — spikes usually accompany news.", view, "volume")
    },
    {
      key: "range52w",
      label: "52-week range",
      value:
        typeof view.fiftyTwoWeekLow === "number" && typeof view.fiftyTwoWeekHigh === "number"
          ? `${fmtMoney(view.fiftyTwoWeekLow)} – ${fmtMoney(view.fiftyTwoWeekHigh)}`
          : null,
      title: "The lowest and highest prices over the past 52 weeks — the band the derived reward:risk and %-from-high metrics are measured against."
    }
  ];

  return (
    <Disclosure
      title="Fundamentals & market data"
      titleHint="Every raw enrichment field the last scan knew for this symbol.  An em dash means the data wasn't available; 'n/a' on P/E means earnings are negative/zero (a real state, not missing data).  Hover each row for meaning and source."
    >
      <div className="grid gap-x-6 sm:grid-cols-2">
        {rows.map((r) => (
          <div
            key={r.key}
            className="con-row -mx-1 flex cursor-default items-baseline justify-between gap-3 rounded px-1 py-1 text-[length:var(--con-fs-sm)]"
            title={r.title}
          >
            <span className="text-[color:var(--con-faint)]">{r.label}</span>
            <span className={cx("con-num text-right", r.na && "text-[color:var(--con-muted)]", r.stale && "italic opacity-70")}>{r.value ?? <Dash />}</span>
          </div>
        ))}
      </div>
    </Disclosure>
  );
}

// ── Evidence & headlines ─────────────────────────────────────────────────────

export function EvidenceSection({ view }: { view: QuoteView }) {
  const bulletins = view.evidenceBulletins ?? [];
  const headlines = view.headlines ?? [];
  if (bulletins.length === 0 && headlines.length === 0) return null;
  return (
    <Disclosure
      title="Evidence & headlines"
      titleHint="One-line web-source evidence bulletins (congressional trades, insider filings, technicals) and recent news headlines the scan collected for this symbol."
    >
      <div className="flex flex-col gap-2">
        {bulletins.map((b, i) => (
          <p
            key={`b-${i}`}
            className="border-l-2 border-[color:var(--con-accent-border)] pl-2.5 text-[length:var(--con-fs-sm)] leading-snug"
            title="Evidence bulletin generated by this app's web-source pipeline during the last scan."
          >
            {b}
          </p>
        ))}
        {headlines.length > 0 && (
          <div className={cx(bulletins.length > 0 && "border-t border-[color:var(--con-line)] pt-2")}>
            <div className="con-card-title mb-1" title="Recent news headlines the scan's news provider returned for this symbol.">
              Recent headlines
            </div>
            <ul className="list-inside list-disc space-y-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
              {headlines.map((h, i) => (
                <li key={`h-${i}`}>{h}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Disclosure>
  );
}

// ── Data sources (per-field provenance) ──────────────────────────────────────

export function SourcesSection({ view }: { view: QuoteView }) {
  const entries = orderedSourceEntries(view.sources);
  if (entries.length === 0 && !view.provider) return null;
  return (
    <Disclosure
      title="Data sources"
      titleHint="Which provider actually supplied each field in the last scan — real per-field provenance, recorded when the data was fetched."
    >
      <div className="flex flex-col">
        {view.provider && (
          <div className="con-row -mx-1 flex items-center justify-between rounded px-1 py-1 text-[length:var(--con-fs-xs)]" title="The primary quote provider for this symbol in the last scan.">
            <span className="text-[color:var(--con-faint)]">Primary quote</span>
            <Chip tone="muted">{friendlySource(view.provider)}</Chip>
          </div>
        )}
        {entries.map(([field, provider]) => (
          <div
            key={field}
            className="con-row -mx-1 flex items-center justify-between rounded px-1 py-1 text-[length:var(--con-fs-xs)]"
            title={`${provenanceLabel(field)} came from ${friendlySource(provider)} in the last scan.`}
          >
            <span className="text-[color:var(--con-faint)]">{provenanceLabel(field)}</span>
            <Chip tone="muted">{friendlySource(provider)}</Chip>
          </div>
        ))}
      </div>
    </Disclosure>
  );
}
