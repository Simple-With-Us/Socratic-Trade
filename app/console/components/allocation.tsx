"use client";

/** Allocation — where the account's value sits right now, as horizontal bars
 *  (parity port of the legacy allocation donut, improved: bars are readable at
 *  any segment count and label every number). Two lenses: by position and by
 *  sector. Sector comes from the broker/enrichment data on each position —
 *  positions without one are grouped honestly as "no sector data", never
 *  guessed. Cash is always its own segment. */

import { useMemo, useState } from "react";
import type { DashboardSnapshot } from "../../dashboard-types";
import { deriveReality } from "../lib/derive";
import { cx, fmtMoney, fmtPct } from "../lib/format";
import { Btn, Card, Chip, Empty } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

interface Segment {
  label: string;
  value: number;
  pct: number;
  /** cash renders muted; everything else renders accent. */
  kind: "position" | "sector" | "cash";
  /** For sector rows: how many positions the bucket contains. */
  count?: number;
  symbol?: string;
  detail?: string;
}

const NO_SECTOR = "No sector data";

export function AllocationCard({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [lens, setLens] = useState<"position" | "sector">("position");
  const reality = deriveReality(snapshot);

  const { segments, total, hasSectorData } = useMemo(() => {
    const positions = snapshot.positions ?? [];
    const equity = positions.reduce((sum, p) => sum + (Number.isFinite(p.marketValue) ? p.marketValue : 0), 0);
    const reportedTotal = snapshot.portfolio?.totalMarketValue;
    const totalValue = typeof reportedTotal === "number" && Number.isFinite(reportedTotal) && reportedTotal > 0 ? reportedTotal : equity;
    const cash = typeof snapshot.portfolio?.cash === "number" && Number.isFinite(snapshot.portfolio.cash)
      ? Math.max(0, snapshot.portfolio.cash)
      : Math.max(0, totalValue - equity);
    const denom = totalValue > 0 ? totalValue : equity + cash;
    const pctOf = (v: number) => (denom > 0 ? (v / denom) * 100 : 0);
    const anySector = positions.some((p) => !!p.sector);

    let rows: Segment[];
    if (lens === "sector") {
      const buckets = new Map<string, { value: number; count: number }>();
      for (const p of positions) {
        const key = p.sector || NO_SECTOR;
        const bucket = buckets.get(key) ?? { value: 0, count: 0 };
        bucket.value += p.marketValue;
        bucket.count += 1;
        buckets.set(key, bucket);
      }
      rows = [...buckets.entries()].map(([label, b]) => ({
        label,
        value: b.value,
        pct: pctOf(b.value),
        kind: "sector" as const,
        count: b.count,
        detail:
          label === NO_SECTOR
            ? `${b.count} position${b.count === 1 ? "" : "s"} without sector data from the provider — grouped here rather than guessed.`
            : `${b.count} position${b.count === 1 ? "" : "s"} in ${label}.`
      }));
    } else {
      rows = positions.map((p) => ({
        label: p.symbol,
        value: p.marketValue,
        pct: pctOf(p.marketValue),
        kind: "position" as const,
        symbol: p.symbol,
        detail: `${p.symbol}: ${fmtMoney(p.marketValue)} market value${p.sector ? ` · ${p.sector}` : ""}.`
      }));
    }
    rows.sort((a, b) => b.value - a.value);
    if (cash > 0 || rows.length === 0) {
      rows.push({
        label: "Cash",
        value: cash,
        pct: pctOf(cash),
        kind: "cash",
        detail: "Uninvested cash in the account."
      });
    }
    return { segments: rows, total: denom, hasSectorData: anySector };
  }, [snapshot.positions, snapshot.portfolio, lens]);

  const empty = total <= 0 && segments.every((s) => s.value <= 0);

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Allocation
          <Chip tone={reality.tone} title={reality.clarification}>
            {reality.word} · {reality.phrase}
          </Chip>
        </span>
      }
      action={
        !empty ? (
          <div className="flex gap-1">
            <Btn
              size="sm"
              variant={lens === "position" ? "primary" : "ghost"}
              onClick={() => setLens("position")}
              title="One bar per position, plus cash."
            >
              By position
            </Btn>
            <Btn
              size="sm"
              variant={lens === "sector" ? "primary" : "ghost"}
              onClick={() => setLens("sector")}
              title={
                hasSectorData
                  ? "Positions grouped by their sector, plus cash."
                  : "Positions grouped by sector.  No position carries sector data right now, so everything lands in one honest bucket."
              }
            >
              By sector
            </Btn>
          </div>
        ) : undefined
      }
    >
      {empty ? (
        <Empty>No value to allocate yet — no positions and no reported cash for this account.</Empty>
      ) : (
        <div className="flex flex-col">
          {segments.map((s) => (
            <div
              key={`${s.kind}-${s.label}`}
              className="con-row rounded-control px-1.5 py-1.5"
              title={`${s.detail ?? s.label} ${fmtPct(s.pct, 1)} of the account's total value.`}
            >
              <div className="flex items-baseline justify-between gap-3 text-[length:var(--con-fs-sm)]">
                <span className={cx("truncate font-semibold", s.kind === "cash" && "text-[color:var(--con-muted)]")}>
                  {s.symbol ? <SymbolButton symbol={s.symbol} className="text-inherit" /> : s.label}
                  {s.kind === "sector" && typeof s.count === "number" && (
                    <span className="ml-1.5 font-normal text-[color:var(--con-faint)]">×{s.count}</span>
                  )}
                </span>
                <span className="con-num shrink-0 text-[color:var(--con-muted)]">
                  {fmtMoney(s.value)} · {fmtPct(s.pct, 1)}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[color:var(--con-surface-3)]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, Math.max(0, s.pct))}%`,
                    background: s.kind === "cash" ? "var(--con-faint)" : "var(--con-accent)"
                  }}
                />
              </div>
            </div>
          ))}
          <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            Share of total account value ({fmtMoney(total)}), positions marked to the latest known prices. Quotes may
            be delayed.
          </p>
        </div>
      )}
    </Card>
  );
}
