import { Card } from "../ui/primitives";

/**
 * Static, self-contained mock of a decision-trace "receipt" for the marketing page.
 * Content is intentionally illustrative (obviously not a live proposal) — no data
 * fetching, no real symbol pricing, no reuse of console components. Tokens only
 * (bg-surface, pos/neg/warn, accent, text-muted, …) so it themes with light/dark.
 */
export function DecisionTraceIllustration() {
  return (
    <div className="mx-auto max-w-xl space-y-3">
      <Card className="overflow-hidden border-line-strong" aria-hidden="true">
        {/* Header: illustrative order line */}
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-sm font-bold text-fg">
            BUY <span className="font-semibold text-muted">NVDA</span>
          </span>
          <span className="text-xs font-semibold tnum text-muted">~$4,200</span>
        </div>

        <div className="space-y-3 px-5 py-4">
          {/* Green team: proposer + confidence */}
          <div className="rounded-xl border border-pos/25 bg-pos/5 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-pos">
                  Proposed by (green team)
                </p>
                <p className="mt-1 text-sm font-medium text-fg">gpt-5-thesis-v2</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-lg font-bold leading-none tnum text-fg">
                  82<span className="text-xs font-semibold text-faint">/100</span>
                </p>
                <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
                  confidence
                </p>
              </div>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              &ldquo;Earnings momentum and a fresh product cycle outweigh near-term valuation
              risk.&rdquo;
            </p>
          </div>

          {/* Red team: adversarial verdict */}
          <div className="rounded-xl border border-neg/25 bg-neg/5 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-neg">
              Devil&apos;s advocate (red team) — objection
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              &ldquo;Sector concentration is already elevated; sizing should come down before this
              adds exposure.&rdquo;
            </p>
          </div>

          {/* Policy gate line: advisory, never a hard scolding block */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2">
            <span className="text-xs font-semibold text-fg">Policy gate</span>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warn">
              <span aria-hidden="true">&#9888;</span> approved, sized down
            </span>
          </div>
        </div>
      </Card>
      <p className="text-center text-xs text-faint">Illustration of a decision receipt.</p>
    </div>
  );
}
