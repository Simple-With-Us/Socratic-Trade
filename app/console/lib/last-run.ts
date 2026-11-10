/** Presentation of the strategy bar's "Last run ..." line on the console home.
 *
 *  The reason a run failed is already sitting on the very row that renders the
 *  status: `finishStrategyRun` persists it as `summary` on the failure path
 *  (src/lib/strategy.ts), the stale-run sweep writes a human-readable one too
 *  (src/lib/db-execution.ts), and the runs query reads it straight back. The
 *  console home used to drop it on the floor and render only "Last run failed .
 *  23h ago", so the one place that already knew WHY told you nothing and the
 *  only way to find out was to open the Journal and expand the run.
 *
 *  UX PR-A1: pre-decision skips (budget / market closed / broker unhealthy) are
 *  not "completed". They render with an honest chip label and warn tone — never
 *  a success-ish completed state. Market-closed skips keep the cause out of the
 *  inline line (the strategy bar already has a "Paused · market closed" chip);
 *  budget and broker skips surface a short cause so the operator sees why.
 *
 *  Kept as a pure function rather than a component because app/console/page.tsx
 *  is an app-router page file: Next 16 type-checks its exports against a
 *  whitelist (default / metadata / dynamic / ...), so anything extra exported
 *  from it fails `tsc --noEmit` and the build. A helper module can be imported
 *  by the page and unit-tested on its own.
 */

import type { StrategyRunRow } from "@/lib/types";
import {
  classifyStrategyRunSkip,
  isStrategyRunSkipStatus,
  strategyRunStatusLabel
} from "@/lib/strategy-run-status";

/** The inline cause is truncated to this many characters. Long enough for the
 *  common one-sentence failures ("Kill switch is active.") without pushing the
 *  spend/authority block off the right edge of the strategy bar. The full text
 *  always survives in the tooltip. */
export const LAST_RUN_CAUSE_CHARS = 60;

export interface LastRunPresentation {
  /** Tone the line negative (hard failure). */
  failed: boolean;
  /** Pre-decision skip — non-success, warn tone (not green "completed"). */
  skipped: boolean;
  /** Chip / inline status word, e.g. "Skipped — LLM budget". */
  statusLabel: string;
  /** Full persisted summary for the `title` tooltip; undefined when the run recorded none. */
  title: string | undefined;
  /** Truncated cause to render inline, or undefined when there is nothing to render. */
  cause: string | undefined;
}

export function describeLastRun(run: Pick<StrategyRunRow, "status" | "summary">): LastRunPresentation {
  const summary = run.summary?.trim() || undefined;
  const failed = run.status === "failed";
  const skipped = isStrategyRunSkipStatus(run.status);
  const skipClass = skipped ? classifyStrategyRunSkip(run.status, summary) : null;
  const statusLabel = strategyRunStatusLabel(run.status, summary);

  // Inline cause:
  // - failures always (the reason is the whole point of the line)
  // - budget / broker skips: operator needs the why; market-closed already has a
  //   separate bar chip so echoing it is noise
  // - completed: tooltip only
  let cause: string | undefined;
  if (failed && summary) {
    cause = truncate(summary, LAST_RUN_CAUSE_CHARS);
  } else if (skipped && summary && skipClass !== "market_closed") {
    cause = truncate(summary, LAST_RUN_CAUSE_CHARS);
  }

  return {
    failed,
    skipped,
    statusLabel,
    title: summary,
    cause
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}
