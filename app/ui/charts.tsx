"use client";

import { useId } from "react";
import type { EquityCurvePoint } from "@/lib/types";
import { formatPct, money, signedMoney } from "../dashboard-widgets";

const ALLOC_COLORS = ["#10b981", "#3b82f6", "#8b5cf6", "#f59e0b", "#06b6d4", "#ef4444", "#84cc16", "#ec4899"];

export function EquityCurve({ data }: { data: EquityCurvePoint[] }) {
  // Scope the gradient id so two equity curves on one page can't collide.
  const gradientId = `equity-fill-${useId().replace(/:/g, "")}`;
  if (data.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-faint">No equity history yet</div>;
  }

  const width = 640;
  const height = 220;
  const pad = 16;
  const values = data.map((point) => point.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const xFor = (index: number) => pad + (data.length === 1 ? 0.5 : index / (data.length - 1)) * (width - pad * 2);
  const yFor = (value: number) => height - pad - ((value - min) / span) * (height - pad * 2);
  const points = data.map((point, index) => `${xFor(index).toFixed(1)},${yFor(point.equity).toFixed(1)}`).join(" ");
  const area = `${pad},${height - pad} ${points} ${width - pad},${height - pad}`;
  const latest = data[data.length - 1];

  return (
    <div className="relative h-full min-h-[180px]">
      <svg className="h-full w-full overflow-visible" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Equity curve">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="var(--line)" strokeWidth="1" />
        <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="var(--line)" strokeWidth="1" />
        <polygon points={area} fill={`url(#${gradientId})`} />
        <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {latest && <circle cx={xFor(data.length - 1)} cy={yFor(latest.equity)} r="4" fill="var(--accent)" />}
      </svg>
      <div className="pointer-events-none absolute right-2 top-2 rounded-md border border-line bg-surface/80 px-2 py-1 text-xs text-muted">
        <span className="tnum text-fg">{latest ? money(latest.equity) : "-"}</span>
      </div>
    </div>
  );
}

export function AllocationDonut({
  segments
}: {
  segments: Array<{ label: string; value: number; pct: number }>;
}) {
  if (segments.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-faint">No allocation data</div>;
  }

  const gradient = conicGradient(segments);
  return (
    <div className="flex items-center gap-4">
      <div
        className="relative h-[150px] w-[150px] shrink-0 rounded-full"
        style={{ background: gradient }}
        role="img"
        aria-label="Portfolio allocation"
      >
        <div className="absolute inset-[34px] rounded-full border border-line bg-surface" />
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((segment, index) => (
          <span key={segment.label} className="flex items-center gap-1.5 text-xs text-muted">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: segment.label === "Cash" ? "var(--faint)" : ALLOC_COLORS[index % ALLOC_COLORS.length] }}
            />
            <span className="text-fg">{segment.label}</span>
            <span className="tnum text-faint">{segment.pct.toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ScorecardBars({
  data,
  height = 150
}: {
  data: Array<{ label: string; pnl: number; winRate: number; trades: number; avgDaysHeld?: number; shortTermPct?: number }>;
  height?: number;
}) {
  if (data.length === 0) {
    return <div className="py-6 text-center text-xs text-faint">No closed trades yet — outcomes appear once positions close.</div>;
  }

  const rows = data.slice(0, 7);
  const maxAbs = Math.max(1, ...rows.map((row) => Math.abs(row.pnl)));
  return (
    <div className="space-y-2" style={{ minHeight: Math.max(height, rows.length * 30) }}>
      {rows.map((row) => {
        const width = Math.max(6, (Math.abs(row.pnl) / maxAbs) * 100);
        const positive = row.pnl >= 0;
        // Turnover/tax-lot context (avg holding days + % of lots closed short-term) — surfaced in the
        // tooltip only when present, so it never adds noise for sources that don't compute it.
        const turnover = [
          typeof row.avgDaysHeld === "number" ? `${row.avgDaysHeld.toFixed(0)}d avg hold` : null,
          typeof row.shortTermPct === "number" ? `${row.shortTermPct.toFixed(0)}% short-term` : null
        ]
          .filter(Boolean)
          .join(" - ");
        return (
          <div key={row.label} className="grid grid-cols-[112px_minmax(0,1fr)_88px] items-center gap-2 text-xs">
            <div className="truncate text-muted" title={row.label}>{row.label}</div>
            <div className="relative h-3 w-full overflow-hidden rounded-full bg-surface-3/30">
              {/* Midpoint line */}
              <div className="absolute left-1/2 top-0 h-full w-[1px] bg-line-strong/80 z-10" />
              
              {/* Negative bar (grows left from center) */}
              {!positive && (
                <div className="absolute right-1/2 top-0 h-full flex justify-end" style={{ width: `${width / 2}%` }}>
                  <div
                    className="h-full w-full rounded-l-full bg-down"
                    title={`${signedMoney(row.pnl)} - ${formatPct(row.winRate)} win - ${row.trades} trades${turnover ? ` - ${turnover}` : ""}`}
                  />
                </div>
              )}
              
              {/* Positive bar (grows right from center) */}
              {positive && (
                <div className="absolute left-1/2 top-0 h-full flex justify-start" style={{ width: `${width / 2}%` }}>
                  <div
                    className="h-full w-full rounded-r-full bg-up"
                    title={`${signedMoney(row.pnl)} - ${formatPct(row.winRate)} win - ${row.trades} trades${turnover ? ` - ${turnover}` : ""}`}
                  />
                </div>
              )}
            </div>
            <div className={positive ? "tnum text-right text-up" : "tnum text-right text-down"}>{signedMoney(row.pnl)}</div>
          </div>
        );
      })}
    </div>
  );
}

function conicGradient(segments: Array<{ label: string; pct: number }>): string {
  let cursor = 0;
  const stops = segments.flatMap((segment, index) => {
    const color = segment.label === "Cash" ? "var(--faint)" : ALLOC_COLORS[index % ALLOC_COLORS.length];
    const start = cursor;
    const end = Math.min(100, cursor + segment.pct);
    cursor = end;
    return [`${color} ${start.toFixed(2)}%`, `${color} ${end.toFixed(2)}%`];
  });
  return `conic-gradient(${stops.join(", ")})`;
}
