"use client";

import { cx } from "../lib/format";

export function ApprovalCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        "con-card animate-pulse flex flex-col overflow-hidden rounded-[var(--con-radius)] border border-[color:var(--con-line)] bg-[color:var(--con-surface)] shadow-[var(--con-shadow)]",
        className
      )}
      aria-hidden="true"
    >
      {/* Header skeleton */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[color:var(--con-line)] px-4 py-3">
        <div className="h-6 w-16 rounded-full bg-[color:var(--con-line-strong)] opacity-60" />
        <div className="h-6 w-24 rounded-full bg-[color:var(--con-line-strong)] opacity-60" />
        <div className="h-5 w-20 rounded bg-[color:var(--con-line)] opacity-60" />
        <div className="ml-auto h-5 w-24 rounded-full bg-[color:var(--con-line)] opacity-60" />
      </div>

      {/* Body skeleton */}
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="h-5 w-28 rounded-full bg-[color:var(--con-line-strong)] opacity-50" />
          <div className="h-5 w-20 rounded-full bg-[color:var(--con-line)] opacity-50" />
          <div className="h-5 w-24 rounded-full bg-[color:var(--con-line)] opacity-50" />
        </div>

        <div className="space-y-2 py-1">
          <div className="h-4 w-full rounded bg-[color:var(--con-line)] opacity-50" />
          <div className="h-4 w-5/6 rounded bg-[color:var(--con-line)] opacity-50" />
          <div className="h-4 w-4/6 rounded bg-[color:var(--con-line)] opacity-40" />
        </div>

        <div className="mt-1 flex items-center gap-3">
          <div className="h-9 flex-1 rounded-[var(--con-radius-sm)] bg-[color:var(--con-line-strong)] opacity-60" />
          <div className="h-9 flex-1 rounded-[var(--con-radius-sm)] bg-[color:var(--con-line)] opacity-60" />
        </div>
      </div>
    </div>
  );
}
