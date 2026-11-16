"use client";

/** ~90-day trend sparklines for the Macro board. Pure SVG, tokens only —
 *  polarity decides the color (rising VIX/credit spreads = bad = red), and
 *  series where direction isn't inherently good or bad stay neutral. */

import { Card } from "../ui/primitives";
import { TREND_DEFS } from "./indicators";

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 120;
  const h = 30;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * (w - 2) + 1;
      const y = h - 1 - ((v - min) / range) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" className="block" aria-hidden>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TrendsCard({ history }: { history?: Record<string, number[]> }) {
  if (!history) return null;
  const items = TREND_DEFS.map((d) => ({ ...d, data: history[d.key] })).filter(
    (d): d is (typeof d) & { data: number[] } => Array.isArray(d.data) && d.data.length >= 2
  );
  if (items.length === 0) return null;

  return (
    <Card
      title={
        <span title="Daily closes over roughly the last 90 days, from the same feeds as the tiles below.  Shape and direction matter more than any single point.">
          Trends · ~90 days
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((it) => {
          const last = it.data[it.data.length - 1];
          const first = it.data[0];
          const up = last >= first;
          const chgPct = first !== 0 ? ((last - first) / first) * 100 : 0;
          // Inverse polarity: rising is bad. Neutral: stays muted either way.
          const color =
            it.polarity === "inverse"
              ? up
                ? "var(--con-neg)"
                : "var(--con-pos)"
              : "var(--con-faint)";
          const dirWord = up ? "up" : "down";
          return (
            <div
              key={it.key}
              className="con-row rounded-[var(--con-radius-sm)] border border-[color:var(--con-line)] p-3"
              title={`${it.what} Latest ${last.toFixed(2)}${it.suffix}, ${dirWord} ${Math.abs(chgPct).toFixed(1)}% over roughly 90 days.`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="con-card-title">{it.label}</span>
                <span className="con-num text-[length:var(--con-fs-xs)] font-semibold">
                  {last.toFixed(2)}
                  {it.suffix}
                </span>
              </div>
              <div className="mt-2">
                <Sparkline data={it.data} color={color} />
              </div>
              <div className="con-num mt-1 text-[length:var(--con-fs-xs)]" style={{ color }}>
                {chgPct >= 0 ? "+" : ""}
                {chgPct.toFixed(1)}% / 90d
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
