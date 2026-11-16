"use client";

/** Unified ProposalScorecard renderer (external-repo lessons r3): one collapsible block for the
 *  deterministic decision receipt persisted on TradeProposal.scorecard — core conclusion, MA/volume
 *  data perspective, sniper price levels, the action checklist (a rendering of gate state, never a
 *  new authority), the four-bucket signal attribution, and the decision chain.  Sections absent
 *  from the persisted scorecard are simply not rendered — no fabricated placeholders.  Used
 *  inside the approval card and read-only in the decision trace. */

import { useState } from "react";
import { ChevronDown, ChevronUp, ClipboardList, Crosshair, LineChart } from "lucide-react";
import type { DecisionStep, ProposalScorecard, ProposalScorecardChecklistItem } from "@/lib/types";
import { cx, fmtMoney, fmtNum, EM_DASH, SENTENCE_GAP } from "../lib/format";
import { Chip } from "../ui/primitives";

const CHECK_TONE: Record<ProposalScorecardChecklistItem["status"], "pos" | "warn" | "neg"> = {
  pass: "pos",
  warn: "warn",
  fail: "neg"
};

const CHECK_LABEL: Record<ProposalScorecardChecklistItem["status"], string> = {
  pass: "pass",
  warn: "warn",
  fail: "fail"
};

const STEP_LABEL: Record<DecisionStep, string> = {
  proposed: "Proposed",
  red_team_reject: "Red Team reject",
  override_requested: "Override requested",
  override_applied: "Override applied",
  human_approved: "Human approved",
  final: "Final"
};

const MA_META: Record<
  NonNullable<ProposalScorecard["dataPerspective"]>["maAlignment"],
  { label: string; tone: "pos" | "warn" | "neg" | "muted"; title: string }
> = {
  above_both: { label: "above both MAs", tone: "pos", title: "Price sits above both the 50-day and 200-day moving averages — an uptrend read." },
  below_both: { label: "below both MAs", tone: "neg", title: "Price sits below both the 50-day and 200-day moving averages — a downtrend read." },
  mixed: { label: "mixed vs MAs", tone: "warn", title: "Price sits between the 50-day and 200-day moving averages — no clean trend read." },
  unknown: { label: "MA data unavailable", tone: "muted", title: "No moving-average series was available when this proposal was built.  Nothing is fabricated in its place." }
};

const ATTRIBUTION_META: Array<{ key: "technical" | "news" | "fundamentals" | "market"; label: string; color: string }> = [
  { key: "technical", label: "Technical", color: "var(--con-accent)" },
  { key: "news", label: "News", color: "var(--con-warn)" },
  { key: "fundamentals", label: "Fundamentals", color: "var(--con-pos)" },
  { key: "market", label: "Market", color: "var(--con-faint)" }
];

/** Preserve the two-space sentence gap when persisted copy reaches HTML. */
function gapText(text: string): string {
  return text.replace(/ {2}/g, SENTENCE_GAP);
}

function fmtVolume(v: number | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return EM_DASH;
  if (v >= 1_000_000) return `${fmtNum(v / 1_000_000)}M`;
  if (v >= 1_000) return `${fmtNum(v / 1_000)}K`;
  return fmtNum(v);
}

export function ProposalScorecardBlock({
  scorecard,
  defaultOpen = false
}: {
  scorecard: ProposalScorecard;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const core = scorecard.coreConclusion;
  const data = scorecard.dataPerspective;
  const sniper = scorecard.sniperPoints;
  const checklist = scorecard.actionChecklist ?? [];
  const attribution = scorecard.signalAttribution;
  const chain = scorecard.decisionChain ?? [];
  const hasBody = Boolean(core || data || sniper || checklist.length > 0 || attribution || chain.length > 0);
  if (!hasBody) return null;

  return (
    <div className="rounded-control border border-[color:var(--con-line)]">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Deterministic decision receipt assembled from data the pipeline already computed — no model authors any field."
      >
        {open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        Decision scorecard
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-[color:var(--con-line)] px-3 py-3 text-[length:var(--con-fs-sm)]">
          {core && (
            <div>
              <div className="con-card-title mb-1">Core conclusion</div>
              {core.thesis && <p className="leading-relaxed text-[color:var(--con-muted)]">{gapText(core.thesis)}</p>}
              <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                <strong>If flat:</strong> {gapText(core.noPositionAdvice)}
              </p>
              <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                <strong>If holding:</strong> {gapText(core.hasPositionAdvice)}
              </p>
            </div>
          )}

          {data && (
            <div>
              <div className="con-card-title mb-1 flex items-center gap-1.5">
                <LineChart size={12} /> Data perspective
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[length:var(--con-fs-xs)]">
                <Chip tone={MA_META[data.maAlignment].tone} title={MA_META[data.maAlignment].title}>
                  {MA_META[data.maAlignment].label}
                </Chip>
                <span className="con-num text-[color:var(--con-muted)]" title="Decision-time price vs the 50-day / 200-day simple moving averages.  Missing values were unavailable, never invented.">
                  {fmtMoney(data.priceVsMa.price)} vs SMA50 {data.priceVsMa.sma50 !== undefined ? fmtMoney(data.priceVsMa.sma50) : EM_DASH} · SMA200{" "}
                  {data.priceVsMa.sma200 !== undefined ? fmtMoney(data.priceVsMa.sma200) : EM_DASH}
                </span>
                {(data.volume.current !== undefined || data.volume.avg20d !== undefined) && (
                  <span className="con-num text-[color:var(--con-faint)]" title="Latest daily volume vs the trailing 20-day average volume.">
                    vol {fmtVolume(data.volume.current)} / 20d avg {fmtVolume(data.volume.avg20d)}
                  </span>
                )}
              </div>
            </div>
          )}

          {sniper && (
            <div>
              <div className="con-card-title mb-1 flex items-center gap-1.5">
                <Crosshair size={12} /> Sniper points
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[length:var(--con-fs-xs)] sm:grid-cols-4">
                <div title="The persisted decision-time entry anchor (referencePrice).">
                  <dt className="text-[color:var(--con-faint)]">Entry</dt>
                  <dd className="con-num font-semibold">{sniper.idealBuy !== undefined ? fmtMoney(sniper.idealBuy) : EM_DASH}</dd>
                </div>
                {sniper.secondaryBuy !== undefined && (
                  <div
                    title={
                      sniper.secondaryBuyBasis === "owner-set"
                        ? "Owner-configured secondary entry (secondaryBuyPullbackPct override).  Display only — nothing is traded from it."
                        : "Volatility-aware secondary entry derived from ATR(14), clamped 1-4%.  Display only — nothing is traded from it."
                    }
                  >
                    <dt className="flex items-center gap-1 text-[color:var(--con-faint)]">
                      Secondary
                      {sniper.secondaryBuyBasis && (
                        <span className="text-[length:var(--con-fs-2xs)] uppercase tracking-wide text-[color:var(--con-faint)]">
                          {sniper.secondaryBuyBasis === "owner-set" ? "owner-set" : "ATR"}
                        </span>
                      )}
                    </dt>
                    <dd className="con-num font-semibold">{fmtMoney(sniper.secondaryBuy)}</dd>
                  </div>
                )}
                <div title="The bracket stop-loss leg attached to this proposal.">
                  <dt className="text-[color:var(--con-faint)]">Stop</dt>
                  <dd className="con-num font-semibold text-[color:var(--con-neg)]">
                    {sniper.stopLoss !== undefined ? fmtMoney(sniper.stopLoss) : EM_DASH}
                  </dd>
                </div>
                <div title="The bracket take-profit leg attached to this proposal.">
                  <dt className="text-[color:var(--con-faint)]">Take profit</dt>
                  <dd className="con-num font-semibold text-[color:var(--con-pos)]">
                    {sniper.takeProfit !== undefined ? fmtMoney(sniper.takeProfit) : EM_DASH}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {checklist.length > 0 && (
            <div>
              <div
                className="con-card-title mb-1 flex items-center gap-1.5"
                title="A rendering of gate outcomes the pipeline already computed — rows exist only for checks that actually ran, and this list decides nothing on its own."
              >
                <ClipboardList size={12} /> Action checklist
              </div>
              <ul className="flex flex-col gap-1">
                {checklist.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 text-[length:var(--con-fs-xs)]">
                    <Chip tone={CHECK_TONE[item.status]} className="shrink-0">
                      {CHECK_LABEL[item.status]}
                    </Chip>
                    <span className="text-[color:var(--con-muted)]">{gapText(item.label)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {attribution && (
            <div>
              <div
                className="con-card-title mb-1"
                title="Deterministic attribution of the scan's factor scores across four signal families, normalized to 100.  Computed from the quote's factor breakdown — no model opinion involved."
              >
                Signal attribution
              </div>
              <div className="mb-1 flex h-2 overflow-hidden rounded-full bg-[color:var(--con-line)]" aria-hidden>
                {ATTRIBUTION_META.map(({ key, color }) =>
                  attribution[key] > 0 ? <div key={key} style={{ flex: attribution[key], background: color }} /> : null
                )}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {ATTRIBUTION_META.map(({ key, label, color }) => (
                  <span key={key} className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
                    {label} <span className="con-num font-semibold text-[color:var(--con-fg)]">{attribution[key]}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {chain.length > 0 && (
            <div>
              <div
                className="con-card-title mb-1"
                title="Append-only lifecycle receipt of what happened to this decision, in order.  Validated at persistence time; malformed chains are receipted, never dropped."
              >
                Decision chain
              </div>
              <div className="flex flex-wrap items-center gap-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                {chain.map((step, index) => (
                  <span key={`${step}-${index}`} className="inline-flex items-center gap-1">
                    {index > 0 && <span aria-hidden>→</span>}
                    <Chip
                      tone={step === "red_team_reject" ? "neg" : step === "final" || step === "human_approved" ? "pos" : "muted"}
                      className={cx(step === "override_applied" && "font-semibold")}
                    >
                      {STEP_LABEL[step] ?? step}
                    </Chip>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
