"use client";

/** Results — measurement, never fabrication. Practice-money and real-money
 *  buckets are reported separately and never share an axis. Uncomputable
 *  figures render as "—" with a reason, not an estimate. Tax figures are
 *  estimates only, clearly labeled. */

import { useMemo, useState } from "react";
import type { RegimeStat, ThesisStat } from "@/lib/performance";
import { EquityChart } from "../components/equity-chart";
import { deriveReality } from "../lib/derive";
import { fmtMoney, fmtPct, fmtQty, fmtSignedMoney, EM_DASH } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { Btn, Card, Chip, Dash, Empty, SignedText, Stat } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

export default function ResultsPage() {
  const { snapshot } = useConsoleData();
  const [compare, setCompare] = useState(false);
  const reality = useMemo(() => (snapshot ? deriveReality(snapshot) : null), [snapshot]);
  if (!snapshot || !reality) return null;

  const perf = snapshot.performance;
  const tax = snapshot.tax;

  // The selected account lives in exactly ONE money-reality, so only its bucket
  // shows by default. The other bucket is one explicit toggle away — never
  // silently mixed onto the page as if it belonged to this account.
  const liveSelected = reality.tone === "live";
  const practiceBucket = (
    <BucketCard
      title="Practice money (Paper broker)"
      tone="paper"
      realized={perf?.paperRealizedPnl}
      unrealized={perf?.paperUnrealizedPnl}
      winRate={perf?.paperWinRate}
      avgReturn={perf?.paperAverageReturnPct}
      curve={perf?.paperEquityCurve ?? []}
    />
  );
  const liveBucket = (
    <BucketCard
      title="Brokerage Account"
      tone="live"
      realized={perf?.liveRealizedPnl}
      unrealized={perf?.liveUnrealizedPnl}
      winRate={perf?.liveWinRate}
      avgReturn={perf?.liveAverageReturnPct}
      curve={perf?.liveEquityCurve ?? []}
    />
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Results</h1>
        <Chip tone={reality.tone}>
          {reality.word} · {reality.phrase}
        </Chip>
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          for {reality.account?.label ?? "no connected account"}
        </span>
        <div className="flex-1" />
        <Btn size="sm" variant="ghost" onClick={() => setCompare((v) => !v)}>
          {compare
            ? "Hide comparison"
            : liveSelected
              ? "Compare with paper account"
              : "Compare with brokerage account"}
        </Btn>
      </div>

      {/* Buckets: selected reality first; the other only on explicit compare. */}
      <div className={compare ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
        {liveSelected ? liveBucket : practiceBucket}
        {compare && (liveSelected ? practiceBucket : liveBucket)}
      </div>
      {compare && (
        <p className="-mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Comparison only — broker-paper and brokerage-account results never share an axis or a total.
        </p>
      )}

      {/* Benchmark */}
      <Card title="Versus the market (SPY buy-and-hold)">
        {perf?.benchmark ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat
                label="Your account"
                value={fmtPct(perf.benchmark.accountReturnPct, 2, true)}
                sub={`${perf.benchmark.startDate} → ${perf.benchmark.endDate}`}
                title="Time-weighted account return over this window when cash flows can be detected; otherwise raw account equity growth. This is the account return before subtracting SPY."
              />
              <Stat label={perf.benchmark.benchmarkSymbol} value={fmtPct(perf.benchmark.benchmarkReturnPct, 2, true)} sub="same window, buy and hold" title="Benchmark buy-and-hold return over the same window." />
              <div>
                <div className="con-card-title">Excess return</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-xl)] font-semibold">
                  <SignedText value={perf.benchmark.excessReturnPct}>
                    <span title="Benchmark-relative return: your account return minus SPY over the same window. This is the alpha-style comparison; other Results percentages are raw account/proposal outcomes unless they explicitly say benchmark or excess.">
                      {fmtPct(perf.benchmark.excessReturnPct, 2, true)}
                    </span>
                  </SignedText>
                </div>
                <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  positive = beating the market
                </div>
              </div>
            </div>
            <p className="mt-3 border-t border-[color:var(--con-line)] pt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {perf.benchmark.cashFlowAdjusted
                ? `Time-weighted return — adjusted for ${fmtMoney(Math.abs(perf.benchmark.netExternalFlows ?? 0))} of detected ${
                    (perf.benchmark.netExternalFlows ?? 0) < 0 ? "withdrawals" : "deposits"
                  } so transfers don't read as gains or losses. Flows are inferred from account snapshots, not a broker transfer ledger.`
                : "Raw equity growth over the window — no deposits or withdrawals were detected. If money moved in or out without being captured in snapshots, this includes those transfers and is not a pure return figure."}
            </p>
          </>
        ) : (
          <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            Not computable yet — the comparison needs enough overlapping history between your equity snapshots and SPY.
            It appears here on its own; nothing is estimated in the meantime.
          </p>
        )}
      </Card>

      {/* Scorecards */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ScorecardCard
          title="By thesis"
          rows={(snapshot.thesisScorecard ?? []).map((t: ThesisStat) => ({
            name: t.thesisTag,
            trades: t.trades,
            winRate: t.winRate,
            avgReturnPct: t.avgReturnPct,
            totalPnl: t.totalPnl
          }))}
          nameLabel="Thesis"
        />
        <ScorecardCard
          title="By market regime at entry"
          rows={(snapshot.regimeScorecard ?? []).map((r: RegimeStat) => ({
            name: r.regime,
            trades: r.trades,
            winRate: r.winRate,
            avgReturnPct: r.avgReturnPct,
            totalPnl: r.totalPnl
          }))}
          nameLabel="Regime"
        />
      </div>

      {/* Tax */}
      <Card
        title="Tax"
        action={<Chip tone="warn">estimates only — not tax advice</Chip>}
      >
        {!tax ? (
          <Empty>No tax summary available for this account yet.</Empty>
        ) : (
          <TaxBlock />
        )}
      </Card>
    </div>
  );
}

function BucketCard({
  title,
  tone,
  realized,
  unrealized,
  winRate,
  avgReturn,
  curve
}: {
  title: string;
  tone: "paper" | "live";
  realized?: number;
  unrealized?: number;
  winRate?: number;
  avgReturn?: number;
  curve: Array<{ timestamp: string; equity: number; source: "live" | "paper" }>;
}) {
  const hasAny = curve.length > 0 || (realized ?? 0) !== 0 || (unrealized ?? 0) !== 0;
  return (
    <Card title={title}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="con-card-title">Realized P&amp;L</div>
          <div className="con-num mt-0.5 text-[length:var(--con-fs-lg)] font-semibold">
            {typeof realized === "number" ? <SignedText value={realized}>{fmtSignedMoney(realized)}</SignedText> : <Dash />}
          </div>
        </div>
        <div>
          <div className="con-card-title">Unrealized P&amp;L</div>
          <div className="con-num mt-0.5 text-[length:var(--con-fs-lg)] font-semibold">
            {typeof unrealized === "number" ? <SignedText value={unrealized}>{fmtSignedMoney(unrealized)}</SignedText> : <Dash />}
          </div>
        </div>
        <div>
          <div className="con-card-title">Win rate</div>
          <div className="con-num mt-0.5">{hasAny && typeof winRate === "number" ? fmtPct(winRate, 0) : EM_DASH}</div>
        </div>
        <div>
          <div className="con-card-title" title="Raw realized return per closed trade in this bucket, not benchmark-relative. The separate SPY panel below handles benchmark/excess return.">Avg return / closed trade</div>
          <div className="con-num mt-0.5" title="Raw realized return per closed trade, based on entry and exit prices. It is not adjusted for SPY or market beta.">
            {hasAny && typeof avgReturn === "number" ? fmtPct(avgReturn, 2, true) : EM_DASH}
          </div>
        </div>
      </div>
      <div className="mt-3 border-t border-[color:var(--con-line)] pt-3">
        <EquityChart points={curve} label={tone === "live" ? "real-money" : "practice-money"} />
        {curve.length >= 2 && (
          <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            Raw account equity — includes any deposits/withdrawals, so a transfer moves this line without being a
            gain or loss. The market comparison below adjusts for detected transfers.
          </p>
        )}
      </div>
    </Card>
  );
}

function ScorecardCard({
  title,
  rows,
  nameLabel
}: {
  title: string;
  rows: Array<{ name: string; trades: number; winRate: number; avgReturnPct: number; totalPnl: number }>;
  nameLabel: string;
}) {
  const sorted = useMemo(() => [...rows].sort((a, b) => b.trades - a.trades), [rows]);
  return (
    <Card title={title} padded={false}>
      {sorted.length === 0 ? (
        <Empty>No closed trades to score yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="con-table">
            <thead>
              <tr>
                <th>{nameLabel}</th>
                <th className="num">n</th>
                <th className="num">Win</th>
                <th className="num" title="Raw average realized return per closed lot in this group, not benchmark-relative. Use the SPY panel for excess return.">Avg</th>
                <th className="num">P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const thin = row.trades < 5;
                return (
                  <tr key={row.name} className={thin ? "opacity-60" : undefined} title={thin ? "Small sample — read with caution." : undefined}>
                    <td className="font-semibold">{row.name}</td>
                    <td className="num con-num">{row.trades}</td>
                    <td className="num con-num">{fmtPct(row.winRate, 0)}</td>
                    <td className="num" title="Raw average realized return for this thesis/regime group. Positive means the closed lots made money in their own direction; it is not SPY-relative.">
                      <SignedText value={row.avgReturnPct}>{fmtPct(row.avgReturnPct, 2, true)}</SignedText>
                    </td>
                    <td className="num">
                      <SignedText value={row.totalPnl}>{fmtSignedMoney(row.totalPnl)}</SignedText>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function TaxBlock() {
  const { snapshot } = useConsoleData();
  const tax = snapshot?.tax;
  if (!tax) return null;

  const ira = tax.settings.taxationType === "roth_ira" || tax.settings.taxationType === "traditional_ira";

  return (
    <div className="flex flex-col gap-4 text-[length:var(--con-fs-sm)]">
      {ira && (
        <p className="text-[color:var(--con-muted)]">
          This is an IRA — no yearly taxes on trades here, so rates are zeroed. A loss realized in a <em>taxable</em>{" "}
          account still locks rebuys of that symbol across all your accounts, including this one.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={`Short-term realized ${tax.taxYear}`} value={fmtSignedMoney(tax.shortTermRealized)} />
        <Stat label="Long-term realized" value={fmtSignedMoney(tax.longTermRealized)} />
        <Stat label="Disallowed wash-sale loss" value={fmtMoney(tax.disallowedWashSaleLoss)} />
        <Stat label="Estimated tax liability" value={fmtMoney(tax.estimatedTaxLiability)} sub={`ST ${fmtMoney(tax.estimatedShortTermTax)} · LT ${fmtMoney(tax.estimatedLongTermTax)}`} />
      </div>

      {tax.lockedSymbols.length > 0 && (
        <div>
          <div className="con-card-title mb-1">Wash-sale lockouts (all your accounts)</div>
          <div className="flex flex-wrap gap-1.5">
            {tax.lockedSymbols.map((s) => (
              <Chip key={s} tone="warn" title="Rebuying within 30 days of the loss would forfeit the loss deduction. The buy gate enforces this automatically.">
                <SymbolButton symbol={s} showLogo={false} className="text-inherit" /> locked
              </Chip>
            ))}
          </div>
        </div>
      )}

      {tax.openLots.length > 0 && (
        <div>
          <div className="con-card-title mb-1">Open lots — days to long-term treatment</div>
          <div className="overflow-x-auto">
            <table className="con-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Qty</th>
                  <th className="num">Days held</th>
                  <th className="num">To long-term</th>
                  <th className="num">Unrealized</th>
                  <th className="num">Early-exit tax cost</th>
                </tr>
              </thead>
              <tbody>
                {[...tax.openLots]
                  .sort((a, b) => a.daysToLongTerm - b.daysToLongTerm)
                  .slice(0, 12)
                  .map((lot, i) => (
                    <tr key={`${lot.symbol}-${i}`}>
                      <td className="font-semibold">
                        <SymbolButton symbol={lot.symbol} showLogo={false} />
                      </td>
                      <td className="num con-num">{fmtQty(lot.quantity)}</td>
                      <td className="num con-num">{lot.daysHeld}</td>
                      <td className="num con-num">{lot.isLongTerm ? "long-term" : `${lot.daysToLongTerm}d`}</td>
                      <td className="num">
                        {typeof lot.unrealizedGain === "number" ? (
                          <SignedText value={lot.unrealizedGain}>{fmtSignedMoney(lot.unrealizedGain)}</SignedText>
                        ) : (
                          EM_DASH
                        )}
                      </td>
                      <td className="num con-num" title="Extra estimated tax if sold now vs waiting for long-term treatment.">
                        {typeof lot.earlyExitTaxPremium === "number" ? `~${fmtMoney(lot.earlyExitTaxPremium)}` : EM_DASH}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tax.harvestCandidates.length > 0 && (
        <div>
          <div className="con-card-title mb-1">Loss-harvest candidates</div>
          <div className="flex flex-wrap gap-1.5">
            {tax.harvestCandidates.slice(0, 8).map((h) => (
              <Chip key={h.symbol} tone="muted">
                <SymbolButton symbol={h.symbol} showLogo={false} className="text-inherit" /> {fmtSignedMoney(h.unrealizedLoss)}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
