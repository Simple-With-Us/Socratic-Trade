"use client";

/** Positions table with a per-position protection column derived honestly
 *  from the snapshot (resting broker stop order, app-managed stop rule, or
 *  "—" when nothing protects). Money in tabular numerals; missing = "—". */

import type { DashboardSnapshot } from "../../dashboard-types";
import { deriveProtection } from "../lib/derive";
import { fmtMoney, fmtPct, fmtQty, EM_DASH } from "../lib/format";
import { Card, Dash, Empty, SignedText } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

export function PositionsCard({ snapshot }: { snapshot: DashboardSnapshot }) {
  const positions = snapshot.positions ?? [];
  const equity = snapshot.portfolio?.totalMarketValue;
  return (
    <Card title={`Positions (${positions.length})`} padded={false}>
      {positions.length === 0 ? (
        <Empty>No open positions in this account.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="con-table">
            <thead>
              <tr>
                <th title="Ticker — click a symbol to open its price history and details.">Symbol</th>
                <th className="num" title="Shares held; negative means a short position.">Qty</th>
                <th className="num" title="Average price paid per share.">Avg cost</th>
                <th className="num" title="Current market value of the position.">Value</th>
                <th className="num" title="Share of the account's total market value currently tied to this position.">Weight</th>
                <th className="num" title="Market value minus cost basis — the gain or loss if you closed now.">Unrealized</th>
                <th title="What protects this position: a resting broker stop order, an app-managed stop rule, or nothing (—).">Protection</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const short = p.quantity < 0;
                const costBasis = p.averageCost * p.quantity;
                const unrealized =
                  Number.isFinite(p.marketValue) && Number.isFinite(costBasis) ? p.marketValue - costBasis : undefined;
                const unrealizedPct =
                  unrealized !== undefined && costBasis !== 0 ? (unrealized / Math.abs(costBasis)) * 100 : undefined;
                const weightPct = equity && equity !== 0 ? (p.marketValue / equity) * 100 : undefined;
                const protection = deriveProtection(p, snapshot.orders ?? [], snapshot.policy);
                const meta = snapshot.symbolMetaBySymbol?.[p.symbol];
                return (
                  <tr key={p.symbol}>
                    <td>
                      <SymbolButton symbol={p.symbol} />
                      {short && (
                        <span className="ml-1.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">SHORT</span>
                      )}
                      {meta?.companyName && (
                        <span className="block max-w-44 truncate pl-[26px] text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                          {meta.companyName}
                        </span>
                      )}
                    </td>
                    <td className="num con-num">{fmtQty(p.quantity)}</td>
                    <td className="num con-num">{fmtMoney(p.averageCost)}</td>
                    <td className="num con-num">{fmtMoney(p.marketValue)}</td>
                    <td className="num con-num">{weightPct !== undefined ? fmtPct(weightPct, 1, true) : <Dash />}</td>
                    <td className="num">
                      {unrealized === undefined ? (
                        <Dash />
                      ) : (
                        <SignedText value={unrealized}>
                          {`${unrealized > 0 ? "+" : ""}${fmtMoney(unrealized)}`}
                          {unrealizedPct !== undefined ? ` (${fmtPct(unrealizedPct, 1, true)})` : ""}
                        </SignedText>
                      )}
                    </td>
                    <td title={protection.detail}>
                      {protection.label === null ? (
                        <span className="text-[color:var(--con-faint)]">{EM_DASH}</span>
                      ) : (
                        <span
                          className="text-[length:var(--con-fs-xs)] font-semibold"
                          style={{ color: protection.tone === "warn" ? "var(--con-warn)" : protection.tone === "pos" ? "var(--con-pos)" : "var(--con-muted)" }}
                        >
                          {protection.label}
                        </span>
                      )}
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
