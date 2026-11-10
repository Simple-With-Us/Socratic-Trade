"use client";

import { cx } from "../lib/format";

export function PortfolioOverviewSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        "con-card animate-pulse flex flex-col p-4 rounded-[var(--con-radius)] border border-[color:var(--con-line)] bg-[color:var(--con-surface)] shadow-[var(--con-shadow)]",
        className
      )}
      aria-hidden="true"
    >
      {/* Title skeleton */}
      <div className="mb-4 flex items-center justify-between">
        <div className="h-5 w-40 rounded bg-[color:var(--con-line-strong)] opacity-60" />
        <div className="h-4 w-20 rounded bg-[color:var(--con-line)] opacity-50" />
      </div>

      {/* 4 Stat Grid */}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex flex-col gap-2 rounded-[var(--con-radius-sm)] border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-3">
            <div className="h-3.5 w-24 rounded bg-[color:var(--con-line)] opacity-50" />
            <div className="h-6 w-32 rounded bg-[color:var(--con-line-strong)] opacity-70" />
            <div className="h-3 w-28 rounded bg-[color:var(--con-line)] opacity-40" />
          </div>
        ))}
      </div>

      {/* Mini chart placeholder */}
      <div className="mt-5 border-t border-[color:var(--con-line)] pt-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="h-3.5 w-28 rounded bg-[color:var(--con-line)] opacity-50" />
          <div className="h-3 w-36 rounded bg-[color:var(--con-line)] opacity-40" />
        </div>
        <div className="h-28 w-full rounded-[var(--con-radius-sm)] bg-[color:var(--con-surface-2)] opacity-60" />
      </div>
    </div>
  );
}
