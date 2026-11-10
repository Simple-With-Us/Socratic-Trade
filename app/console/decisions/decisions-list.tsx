"use client";

import Link from "next/link";
import type { SocraticDecisionCase } from "@/lib/types";
import { fmtExact, timeAgo } from "../lib/format";
import { decisionStatusLabel, thesisTagLabel } from "../lib/labels";
import { Card, Chip, Empty } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

/** Tone mirrors the decision lifecycle: placed/filled positive, blocked/rejected
 *  negative, everything in-flight neutral. Words carry the meaning either way. */
function statusTone(status: SocraticDecisionCase["status"]): "pos" | "neg" | "muted" {
  if (status === "placed" || status === "filled") return "pos";
  if (status === "blocked" || status === "rejected" || status === "rejected_by_broker") return "neg";
  return "muted";
}

/** Pure list body — exported for the route smoke test (no fetch, no hooks).
 *  A real <button> (SymbolButton, opening the drawer) can't validly nest
 *  inside a real <a> (the row's "go to the trace" link) — invalid HTML, and
 *  the browser would still follow the anchor's href on click regardless of
 *  the button's own stopPropagation. So the Link is a full-row absolute
 *  overlay (z-index/DOM-order "stretched link" pattern) instead of a
 *  wrapper: it and the visible row content are siblings, not ancestor and
 *  descendant. The content spans stay `static` (NOT `relative`) so they
 *  paint in normal flow, below the overlay — CSS always stacks positioned
 *  descendants above non-positioned ones regardless of DOM order, so a
 *  `relative` content span (even with no z-index) would sit on top of the
 *  overlay across its whole box and swallow clicks the row's Link should
 *  get. Only SymbolButton itself is lifted (`relative z-[1]`) above the
 *  overlay so it stays clickable; the timestamp keeps its own `relative
 *  z-[1]` purely so its hover title tooltip still fires (a deliberate
 *  non-navigating exception, not a bug). Everything else — side label,
 *  thesis-tag chip, thesis text, status chip — falls through to the Link,
 *  same as empty row space. */
/** accountLabelById: this index deliberately interleaves EVERY connected account's decisions
 *  (per-account-visibility, pages-04) -- narrowing to the active account only would be a
 *  functional regression, not a fix. When the caller has more than one connected account, pass
 *  a label map so each row states which account it belongs to instead of leaving that
 *  unlabeled; with 0-1 accounts (or no map) the extra chip is pure clutter and is omitted. */
export function DecisionsList({
  decisions,
  accountLabelById
}: {
  decisions: SocraticDecisionCase[];
  accountLabelById?: Record<string, string>;
}) {
  const showAccountLabels = Boolean(accountLabelById && Object.keys(accountLabelById).length > 1);
  return (
    <Card padded={false}>
      {decisions.length === 0 ? (
        <Empty>No decision traces yet.</Empty>
      ) : (
        <div className="flex flex-col divide-y divide-[color:var(--con-line)]">
          {decisions.map((decision) => {
            const symbolLabel = decision.symbol ?? "Portfolio";
            const sideLabel = decision.side ? ` ${SIDE_LABEL[decision.side] ?? decision.side.toUpperCase()}` : "";
            const accountLabel =
              showAccountLabels && accountLabelById
                ? (decision.connectedAccountId ? accountLabelById[decision.connectedAccountId] : undefined) ??
                  "Unknown account"
                : null;
            return (
              <div
                key={decision.id}
                className="relative flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-[color:var(--con-surface-2)]"
              >
                <Link
                  href={`/console/decisions/${encodeURIComponent(decision.id)}`}
                  aria-label={`View decision trace: ${symbolLabel}${sideLabel}, ${decisionStatusLabel(decision.status)}`}
                  className="absolute inset-0"
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {decision.symbol ? (
                      <SymbolButton symbol={decision.symbol} className="relative z-[1] text-[length:var(--con-fs-sm)]" />
                    ) : (
                      <span className="text-[length:var(--con-fs-sm)] font-semibold">Portfolio</span>
                    )}
                    {decision.side && (
                      <span className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)]">
                        {SIDE_LABEL[decision.side] ?? decision.side.toUpperCase()}
                      </span>
                    )}
                    {decision.thesisTag && <Chip tone="muted">{thesisTagLabel(decision.thesisTag)}</Chip>}
                  </span>
                  {decision.thesis && (
                    <span className="mt-0.5 block truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                      {decision.thesis}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  {accountLabel && (
                    <Chip tone="muted" title="This case's connected account -- decisions from every connected account are interleaved here.">
                      {accountLabel}
                    </Chip>
                  )}
                  <Chip tone={statusTone(decision.status)}>{decisionStatusLabel(decision.status)}</Chip>
                  <span
                    className="relative z-[1] text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
                    title={fmtExact(decision.createdAt)}
                  >
                    {timeAgo(decision.createdAt)}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
