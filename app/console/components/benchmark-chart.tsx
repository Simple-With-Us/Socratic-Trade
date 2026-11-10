"use client";

/** Two honest dollar lines on one axis: account equity vs a same-cash S&P tracker.
 *  No interpolation.  Fewer than two aligned points renders a sentence, not a chart. */

import { memo, useMemo } from "react";
import type { BenchmarkDollarPoint } from "@/lib/types";
import { fmtMoney, fmtSignedMoney, SENTENCE_GAP } from "../lib/format";

const W = 640;
const H = 160;
const PAD_X = 8;
const PAD_Y = 10;

function toMs(date: string): number {
  const t = Date.parse(date.length <= 10 ? `${date}T16:00:00.000Z` : date);
  return Number.isFinite(t) ? t : NaN;
}

export const BenchmarkChart = memo(function BenchmarkChart({
  account,
  shadow,
  accountLabel,
  benchmarkLabel
}: {
  account: BenchmarkDollarPoint[];
  shadow: BenchmarkDollarPoint[];
  accountLabel: string;
  benchmarkLabel: string;
}) {
  const series = useMemo(() => {
    const accountPts = account
      .map((p) => ({ t: toMs(p.date), v: p.value, date: p.date }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    const shadowPts = shadow
      .map((p) => ({ t: toMs(p.date), v: p.value, date: p.date }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    return { accountPts, shadowPts };
  }, [account, shadow]);

  const { accountPts, shadowPts } = series;
  if (accountPts.length < 2 || shadowPts.length < 2) {
    return (
      <p className="py-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
        Not enough overlapping history to draw {accountLabel} against {benchmarkLabel} yet.
      </p>
    );
  }

  const all = [...accountPts, ...shadowPts];
  const tMin = Math.min(...all.map((p) => p.t));
  const tMax = Math.max(...all.map((p) => p.t));
  let vMin = all.reduce((min, d) => (d.v < min ? d.v : min), Infinity);
  let vMax = all.reduce((max, d) => (d.v > max ? d.v : max), -Infinity);
  const mean = all.reduce((sum, d) => sum + d.v, 0) / all.length;
  const minSpan = (Math.abs(mean) || Math.abs(all[all.length - 1]!.v) || 1) * 0.01;
  if (vMax - vMin < minSpan) {
    const center = (vMax + vMin) / 2;
    vMin = center - minSpan / 2;
    vMax = center + minSpan / 2;
  }
  const vSpan = vMax - vMin || 1;
  const tSpan = tMax - tMin || 1;
  const x = (t: number) => PAD_X + ((t - tMin) / tSpan) * (W - PAD_X * 2);
  const y = (v: number) => H - PAD_Y - ((v - vMin) / vSpan) * (H - PAD_Y * 2);
  const pathOf = (pts: typeof accountPts) =>
    pts.map((d, i) => `${i === 0 ? "M" : "L"}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join(" ");

  const accountPath = pathOf(accountPts);
  const shadowPath = pathOf(shadowPts);
  const lastAccount = accountPts[accountPts.length - 1]!;
  const lastShadow = shadowPts[shadowPts.length - 1]!;
  const dollarGap = lastAccount.v - lastShadow.v;
  const tickLabel = (timestamp: number) =>
    new Date(timestamp).toLocaleDateString(undefined, { timeZone: "America/Chicago" });

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${accountLabel} ${fmtMoney(lastAccount.v)} versus ${benchmarkLabel} ${fmtMoney(lastShadow.v)}`}
      >
        <path
          d={shadowPath}
          fill="none"
          stroke="var(--con-muted)"
          strokeWidth="2"
          strokeDasharray="5 4"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d={accountPath}
          fill="none"
          stroke="var(--con-accent)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <figcaption className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        <span className="con-num">
          {tickLabel(tMin)} → {tickLabel(tMax)}
        </span>
        <span className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3 bg-[color:var(--con-accent)]" aria-hidden />
            {accountLabel} {fmtMoney(lastAccount.v)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-0 w-3 border-t-2 border-dashed border-[color:var(--con-muted)]"
              aria-hidden
            />
            {benchmarkLabel} {fmtMoney(lastShadow.v)}
          </span>
          <span className="con-num" title={`Account equity minus the same-cash ${benchmarkLabel} tracker.${SENTENCE_GAP}Positive means you have more dollars.`}>
            {fmtSignedMoney(dollarGap)} vs {benchmarkLabel}
          </span>
        </span>
      </figcaption>
    </figure>
  );
});
