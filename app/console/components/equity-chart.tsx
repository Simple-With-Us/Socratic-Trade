"use client";

/** Minimal honest equity line: an SVG path over persisted snapshot points.
 *  No interpolation, no fabricated baselines — fewer than two points renders
 *  a sentence instead of a chart. Buckets are never overlaid on one axis.
 *  W30 / OD-11 adds the two missing pieces: pointer hover (crosshair guide +
 *  value/drawdown readout at the nearest point) and under-shading of the
 *  region where the curve sits below its running visible-window peak — the
 *  drawdown is computed by lib/equity-drawdown, never a hidden baseline. */

import { memo, useCallback, useMemo, useState } from "react";
import type { EquityCurvePoint } from "@/lib/types";
import { dayKey, fmtExact, fmtMoney, fmtPct, fmtSignedMoney } from "../lib/format";
import { drawdownSeries, maxDrawdownFraction } from "../lib/equity-drawdown";

const W = 640;
const H = 140;
const PAD = 6;

export const EquityChart = memo(function EquityChart({ points, label }: { points: EquityCurvePoint[]; label: string }) {
  const data = useMemo(
    () =>
      points
        .map((p) => ({ t: new Date(p.timestamp).getTime(), v: p.equity }))
        .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
        .sort((a, b) => a.t - b.t),
    [points]
  );

  const [hover, setHover] = useState<number | null>(null);

  // Hooks must run unconditionally (the <2-points branch returns early): the
  // drawdown math and the nearest-point lookup are computed up here.
  const drawdown = useMemo(() => drawdownSeries(data.map((d) => d.v)), [data]);
  const worstDrawdown = useMemo(() => maxDrawdownFraction(drawdown), [drawdown]);

  // W30 hover: the container fraction maps 1:1 onto the viewBox across the
  // preserveAspectRatio="none" stretch, so the nearest-point lookup is honest
  // on any rendered width.
  const nearestIndex = useCallback(
    (clientX: number, rect: DOMRect) => {
      if (data.length < 2) return 0;
      const tSpanLocal = data[data.length - 1].t - data[0].t || 1;
      const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      const t = data[0].t + Math.min(1, Math.max(0, frac)) * tSpanLocal;
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < data.length; i += 1) {
        const dist = Math.abs(data[i].t - t);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return best;
    },
    [data]
  );

  if (data.length < 2) {
    return (
      <p className="py-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
        Not enough history to draw the {label} curve yet — it needs at least two run snapshots.
      </p>
    );
  }

  const tMin = data[0].t;
  const tMax = data[data.length - 1].t;
  let vMin = data.reduce((min, d) => (d.v < min ? d.v : min), Infinity);
  let vMax = data.reduce((max, d) => (d.v > max ? d.v : max), -Infinity);
  // A near-flat curve (e.g. equity barely moved) would otherwise fill the whole
  // vertical range with noise, making a trivial wiggle look like a big swing.
  // Enforce a floor of ±0.5% around the data's own midpoint — real values are
  // never altered, only how much vertical room the axis gives them.
  const mean = data.reduce((sum, d) => sum + d.v, 0) / data.length;
  const minSpan = (Math.abs(mean) || Math.abs(data[data.length - 1].v) || 1) * 0.01;
  if (vMax - vMin < minSpan) {
    const center = (vMax + vMin) / 2;
    vMin = center - minSpan / 2;
    vMax = center + minSpan / 2;
  }
  const vSpan = vMax - vMin || 1;
  const tSpan = tMax - tMin || 1;

  const x = (t: number) => PAD + ((t - tMin) / tSpan) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - vMin) / vSpan) * (H - PAD * 2);
  const path = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join(" ");
  const rising = data[data.length - 1].v >= data[0].v;
  const stroke = rising ? "var(--con-pos)" : "var(--con-neg)";
  const sameDay = dayKey(new Date(tMin).toISOString()) === dayKey(new Date(tMax).toISOString());
  const move = data[data.length - 1].v - data[0].v;
  const movePct = data[0].v !== 0 ? (move / data[0].v) * 100 : undefined;
  const tickLabel = (timestamp: number) =>
    sameDay
      ? new Date(timestamp).toLocaleTimeString([], { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })
      : new Date(timestamp).toLocaleDateString(undefined, { timeZone: "America/Chicago" });

  // W30 shading: the closed region between the running-peak polyline and the
  // curve itself — exactly where the account sat below its visible-window
  // high. Omitted entirely when the window never draws down.
  const hasDrawdown = worstDrawdown !== null && worstDrawdown < -1e-9;
  const peakPath = hasDrawdown
    ? drawdown.map((p, i) => `${i === 0 ? "M" : "L"}${x(data[i].t).toFixed(1)},${y(p.peak).toFixed(1)}`).join(" ")
    : "";
  const shadePath = hasDrawdown
    ? `${peakPath} L${x(tMax).toFixed(1)},${y(data[data.length - 1].v).toFixed(1)} L${x(tMin).toFixed(1)},${y(data[0].v).toFixed(1)} Z`
    : "";

  const hoverPoint = hover === null ? null : data[hover];
  const hoverX = hoverPoint ? x(hoverPoint.t) : 0;
  const hoverPct = hoverPoint ? (hoverX / W) * 100 : 0;
  const hoverDd = hover === null ? null : drawdown[hover].drawdown;

  return (
    <figure>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full h-[120px] sm:h-auto"
          role="img"
          aria-label={`${label} equity from ${fmtMoney(data[0].v)} to ${fmtMoney(data[data.length - 1].v)}`}
          onMouseMove={(e) => setHover(nearestIndex(e.clientX, e.currentTarget.getBoundingClientRect()))}
          onMouseLeave={() => setHover(null)}
        >
          {hasDrawdown && (
            <path d={shadePath} fill="var(--con-warn)" opacity="0.16" aria-hidden="true" />
          )}
          <path d={path} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          {hoverPoint && (
            <>
              <line
                x1={hoverX}
                x2={hoverX}
                y1={PAD}
                y2={H - PAD}
                stroke="var(--con-faint)"
                strokeWidth="1"
                strokeDasharray="3 3"
                aria-hidden="true"
              />
              <circle cx={hoverX} cy={y(hoverPoint.v)} r="3.5" fill={stroke} aria-hidden="true" />
            </>
          )}
        </svg>
        {hoverPoint && (
          <div
            className="pointer-events-none absolute top-0 z-[1] -translate-x-1/2 whitespace-nowrap rounded-control border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] px-2 py-1 text-[length:var(--con-fs-xs)] shadow-sm"
            style={{ left: `${Math.min(92, Math.max(8, hoverPct))}%` }}
          >
            <span className="text-[color:var(--con-muted)]">{tickLabel(hoverPoint.t)}</span>{" "}
            <span className="con-num font-semibold">{fmtMoney(hoverPoint.v)}</span>
            {hoverDd !== null && hoverDd < -1e-9 && (
              <span className="text-[color:var(--con-warn)]"> · {fmtPct(hoverDd * 100, 1)} from peak</span>
            )}
          </div>
        )}
      </div>
      <figcaption className="con-num mt-1 flex justify-between text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        <span title={fmtExact(points[0]?.timestamp)}>
          {tickLabel(tMin)} · {fmtMoney(data[0].v)}
        </span>
        <span title={`${label} move over the visible window`}>
          {fmtSignedMoney(move)}
          {movePct !== undefined ? ` · ${fmtPct(movePct, 2, true)}` : ""}
        </span>
        <span title={fmtExact(points[points.length - 1]?.timestamp)}>
          {tickLabel(tMax)} · {fmtMoney(data[data.length - 1].v)}
        </span>
      </figcaption>
    </figure>
  );
});