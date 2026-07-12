"use client";

/** Receipt-style approval cards. Each pending proposal renders as a decision
 *  receipt: what/how much, the thesis + confidence, the adversarial (red team)
 *  verdict, what has happened since it was proposed, the policy-gate status,
 *  and an honest three-outcomes block. Brokerage approvals go through the
 *  server's typed-confirmation contract (LIVE_CONFIRMATION_REQUIRED). */

import { useMemo, useState } from "react";
import { Database, Ruler, ShieldCheck, Swords, TrendingUp } from "lucide-react";
import type { PendingProposal, SocraticDecisionCase, SocraticRagAttribution, TradingPolicy, TradeProposal } from "@/lib/types";
import type { DashboardSnapshot } from "../../dashboard-types";
import {
  approveProposal,
  rejectProposal,
  ConsoleApiError,
  LiveConfirmationRequiredError,
  type ApproveResult
} from "../lib/api";
import { realityForMode } from "../lib/derive";
import { cx, fmtMoney, fmtNum, fmtPct, fmtQty, timeUntil, EM_DASH } from "../lib/format";
import { DEFAULT_GREEN_MODEL_ID } from "../lib/models";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Ago, Btn, Chip, Dash, LiveTag, SignedText, TextInput } from "../ui/primitives";
import { ModelBadge } from "../ui/provider-logo";
import { Sheet } from "../ui/sheet";
import { SymbolButton } from "../ui/symbol-drilldown";

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

function isExit(side: string): boolean {
  return side === "sell" || side === "cover";
}

function estNotional(p: PendingProposal): number | undefined {
  const v = p.estimatedNotional ?? p.review?.estimatedNotional ?? p.proposal.dollarAmount;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

type RedTeamTrigger = NonNullable<NonNullable<TradeProposal["redTeamVerdict"]>["trigger"]>;

function redTeamTriggerMeta(trigger?: RedTeamTrigger) {
  switch (trigger) {
    case "confidence":
      return { label: "confidence", title: "The proposer confidence cleared the configured Red Team conviction threshold." };
    case "notional":
      return { label: "large notional", title: "The order was large enough as a percentage of NAV to require adversarial review." };
    case "live_opening":
      return { label: "live opening", title: "A live opening order always gets the Red Team receipt when the debate path is available." };
    case "override_requested":
      return { label: "override request", title: "The proposal asked to override an owner preference, so the Red Team reviewed the dissent." };
    case "escalation_regime":
      return { label: "risk regime", title: "The entry regime was Risk-Off, Crisis, or Inverted, so the Red Team reviewed the setup." };
    default:
      return { label: "legacy confidence", title: "Older persisted verdicts predate the trigger field; they came from the original confidence threshold." };
  }
}

function rewardRiskFor(pending: PendingProposal) {
  const p = pending.proposal;
  if (p.side !== "buy" && p.side !== "short") return null;
  const entry = p.referencePrice ?? pending.proposalReferencePrice ?? p.limitPrice;
  const stop = p.bracketStopLoss;
  const target = p.bracketTakeProfit;
  if (!finite(entry) || !finite(stop) || !finite(target) || entry <= 0) return null;

  const reward = p.side === "short" ? entry - target : target - entry;
  const risk = p.side === "short" ? stop - entry : entry - stop;
  if (reward <= 0 || risk <= 0) return null;
  return { entry, stop, target, reward, risk, ratio: reward / risk };
}

function matchedDecision(snapshot: DashboardSnapshot | null, pending: PendingProposal): SocraticDecisionCase | undefined {
  return snapshot?.socratic?.decisions?.find((decision) => decision.proposalId === pending.id);
}

function modelProvenance(p: TradeProposal, policy: TradingPolicy | undefined): string {
  const configured = policy?.llmModel?.trim();
  const served = p.proposedByModel?.trim();
  if (served && configured && served !== configured) return `served ${served}; configured primary was ${configured}`;
  if (served) return `served ${served}`;
  if (configured) return `configured primary ${configured}; served model not persisted on this legacy proposal`;
  return "served model not exposed on this proposal";
}

function fallbackProvenance(p: TradeProposal, policy: TradingPolicy | undefined): string {
  const fallbackModels = policy?.llmFallbackModels?.filter(Boolean) ?? [];
  if (p.proposedByModel && fallbackModels.includes(p.proposedByModel)) return `served by configured fallback ${p.proposedByModel}`;
  if (p.proposedByModel && policy?.llmModel && p.proposedByModel !== policy.llmModel) return "served model differs from configured primary";
  if (fallbackModels.length > 0) return `fallback chain configured (${fallbackModels.length}); no per-hop history on this card`;
  return "no fallback chain configured";
}

function evidenceLabel(item: SocraticRagAttribution): string {
  return [item.docType, item.source, finite(item.score) ? `score ${item.score.toFixed(2)}` : undefined].filter(Boolean).join(" · ") || "retrieved evidence";
}

function expiryIso(p: PendingProposal, policy: TradingPolicy): string | null {
  const minutes = policy.proposalExpiryMinutes;
  if (!minutes || minutes <= 0) return null;
  const t = new Date(p.createdAt).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + minutes * 60_000).toISOString();
}

export function ApprovalCard({ pending }: { pending: PendingProposal }) {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [liveOpen, setLiveOpen] = useState(false);

  const p = pending.proposal;
  const reality = realityForMode(pending.executionMode);
  const live = reality.tone === "live";
  const notional = estNotional(pending);
  const expiresAt = snapshot ? expiryIso(pending, snapshot.policy) : null;
  const decisionCase = matchedDecision(snapshot, pending);
  const rewardRisk = rewardRiskFor(pending);
  const redTrigger = redTeamTriggerMeta(p.redTeamVerdict?.trigger);
  const policy = snapshot?.policy;
  const dailyUsed = finite(pending.decision.dailyNotionalUsed) ? pending.decision.dailyNotionalUsed : snapshot?.dailyStats.notional;
  const dailyRemaining = finite(policy?.maxDailyNotional) && finite(dailyUsed) ? Math.max(0, policy.maxDailyNotional - dailyUsed) : undefined;
  const referencePrice = p.referencePrice ?? pending.proposalReferencePrice;
  const currentDrift =
    finite(referencePrice) && finite(pending.proposalCurrentPrice) && referencePrice > 0
      ? ((pending.proposalCurrentPrice - referencePrice) / referencePrice) * 100
      : undefined;

  // Model attribution prefers the PERSISTED per-proposal values (p.proposedByModel /
  // p.redTeamVerdict.model — stamped failover-aware by src/lib/strategy.ts), falling back
  // to the snapshot policy's configured models only for legacy proposals that predate them
  // (the policy-derived value can be stale if the owner swapped models since proposing).
  const greenModelPersisted = p.proposedByModel?.trim() || null;
  const greenModelConfigured = snapshot?.policy.llmModel?.trim() || null;
  const greenModel = greenModelPersisted ?? greenModelConfigured ?? DEFAULT_GREEN_MODEL_ID;
  const redModel = p.redTeamVerdict?.model?.trim() || snapshot?.policy.redTeamLlmModel?.trim() || greenModel;
  const sizeText =
    typeof p.dollarAmount === "number"
      ? `~${fmtMoney(p.dollarAmount)}`
      : typeof p.quantity === "number"
        ? `${fmtQty(p.quantity)} sh`
        : EM_DASH;

  const finish = (result: ApproveResult) => {
    if (result.status === "placed") {
      toast.push("pos", `${SIDE_LABEL[p.side] ?? p.side} ${p.symbol} placed`, "The order went to the broker with a durable, idempotent intent record.");
    } else if (result.status === "paper") {
      toast.push("pos", `${SIDE_LABEL[p.side] ?? p.side} ${p.symbol} filled (simulated)`, "Recorded as a practice-money fill.");
    } else if (result.status === "blocked") {
      toast.push("warn", "Blocked at approval time", (result.reasons ?? []).join(" ") || "The policy gate re-ran and refused it.");
    } else {
      toast.push("info", `Result: ${result.status}`, (result.reasons ?? []).join(" ") || undefined);
    }
  };

  const approve = async () => {
    if (live) {
      setLiveOpen(true);
      return;
    }
    setBusy("approve");
    try {
      const result = await approveProposal(pending.id);
      await refresh();
      finish(result);
    } catch (error) {
      toast.push("neg", "Approval failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setBusy("reject");
    try {
      await rejectProposal(pending.id);
      await refresh();
      toast.push("info", `Rejected ${p.symbol}`, "The idea keeps being scored — you'll see how it does after you passed.");
    } catch (error) {
      toast.push("neg", "Rejection failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={cx("con-card overflow-hidden", live && "border-[color:var(--con-live-border)]")}>
      {/* Header: verb + company logo + symbol + reality word */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[color:var(--con-line)] px-4 py-3">
        <span className={cx("inline-flex items-center gap-2 text-[length:var(--con-fs-md)] font-bold", isExit(p.side) ? "text-[color:var(--con-warn)]" : undefined)}>
          {SIDE_LABEL[p.side] ?? p.side.toUpperCase()}
          <SymbolButton symbol={p.symbol} logoSize="sm" className="text-inherit" />
        </span>
        <span className="con-num cursor-default text-[length:var(--con-fs-md)] font-semibold" title="Proposed order size (approximate notional or share count).">
          {sizeText}
        </span>
        {isExit(p.side) && (
          <Chip tone="warn" title="Risk-reducing exits are never trapped by caps or universe rules.">
            <ShieldCheck size={11} /> risk-reducing
          </Chip>
        )}
        <div className="flex-1" />
        <Chip tone={reality.tone} title={reality.clarification}>
          {reality.word} · {reality.phrase}
        </Chip>
      </header>

      <div className="flex flex-col gap-3 px-4 py-3 text-[length:var(--con-fs-sm)]">
        {/* Green team: the proposing (bull) model + its conviction, always shown. */}
        <div className="con-team con-team-green">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div
                className="con-card-title mb-1.5"
                title="Green team = the proposer (bull): the model that generated this trade idea and argues for it."
              >
                Proposed by (green team)
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <ModelBadge modelId={greenModel} size="md" title="The model that generated this proposal" />
                {!greenModelPersisted && !greenModelConfigured && (
                  <span
                    className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
                    title="No model is set on the policy; the server uses its default (which an OPENAI_MODEL env override could change)."
                  >
                    (policy default)
                  </span>
                )}
              </div>
            </div>
            {typeof p.confidenceScore === "number" && (
              <div
                className="shrink-0 cursor-default text-right"
                title="The proposing model's stated conviction in this trade, on a 0–100 scale. Higher = stronger conviction; high scores can trigger the red-team debate and influence sizing."
              >
                <span className="con-confidence-num">{p.confidenceScore}</span>
                <span className="con-num text-[length:var(--con-fs-sm)] font-semibold text-[color:var(--con-faint)]">/100</span>
                <div className="con-card-title">confidence</div>
              </div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Chip tone="accent" title="The thesis tag this idea is filed under — its long-run hit rate is tracked on the Results screen.">
              {p.tradeThesisTag}
            </Chip>
            <span className="cursor-default text-[color:var(--con-faint)]" title="The market regime the strategist saw when it proposed this trade.">
              Regime at proposal: {p.entryMarketRegime || EM_DASH}
            </span>
            <span className="text-[color:var(--con-faint)]">
              Proposed <Ago iso={pending.createdAt} />
            </span>
            <Chip tone="muted" title={modelProvenance(p, policy)}>
              {p.proposedByModel ? "served model" : "model legacy"}
            </Chip>
            <Chip tone="muted" title={fallbackProvenance(p, policy)}>
              failover
            </Chip>
          </div>
          <p className="mt-2 leading-relaxed text-[color:var(--con-muted)]">{p.rationale}</p>
        </div>

        {/* Red team: the adversarial (bear) model + its verdict, when the debate ran. */}
        {p.redTeamVerdict?.available && (
          <div className="con-team con-team-red">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div
                className="con-card-title flex items-center gap-1.5"
                title="Red team = the adversarial reviewer (bear): a model tasked with attacking the proposal before you see it."
              >
                <Swords size={12} /> Devil&apos;s advocate (red team)
              </div>
              <ModelBadge modelId={redModel} title="The adversarial reviewer model that critiqued this proposal" />
            </div>
            <p className="mt-1.5 leading-relaxed text-[color:var(--con-muted)]">{p.redTeamVerdict.reason}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[length:var(--con-fs-xs)]">
              <span className="font-semibold" style={{ color: p.redTeamVerdict.rejected ? "var(--con-neg)" : "var(--con-pos)" }}>
                {p.redTeamVerdict.rejected ? "Verdict: rejected" : "Verdict: survived review"}
              </span>
              <Chip tone="warn" title={redTrigger.title}>
                trigger: {redTrigger.label}
              </Chip>
            </div>
          </div>
        )}

        {/* Provenance + sizing receipt */}
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.05fr)_minmax(260px,0.95fr)]">
          <div className="rounded-lg border border-[color:var(--con-line)] p-3">
            <div className="con-card-title mb-2 flex items-center gap-1.5" title="Sizing inputs already available on the approval snapshot; missing values stay blank instead of being inferred.">
              <Ruler size={12} /> Sizing provenance
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[length:var(--con-fs-xs)]">
              <dt className="text-[color:var(--con-faint)]">Advised size</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">{sizeText}</dd>
              <dt className="text-[color:var(--con-faint)]">Broker review notional</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">{fmtMoney(pending.review?.estimatedNotional ?? notional)}</dd>
              <dt className="text-[color:var(--con-faint)]">Per-order cap</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">{fmtMoney(policy?.maxOrderNotional)}</dd>
              <dt className="text-[color:var(--con-faint)]">Daily cap remaining</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">{fmtMoney(dailyRemaining)}</dd>
              <dt className="text-[color:var(--con-faint)]">Projected symbol exposure</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">{fmtPct(pending.decision.projectedSymbolExposurePct, 1)}</dd>
              <dt className="text-[color:var(--con-faint)]">ADV cap</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">{fmtPct(policy?.maxOrderPctOfAdv, 1)}</dd>
              <dt className="text-[color:var(--con-faint)]">Sizer band</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">
                {finite(policy?.tuning?.sizingFloorPct) || finite(policy?.tuning?.sizingCeilingPct)
                  ? `${fmtPct(policy?.tuning?.sizingFloorPct, 0)}-${fmtPct(policy?.tuning?.sizingCeilingPct, 0)}`
                  : EM_DASH}
              </dd>
              <dt className="text-[color:var(--con-faint)]">Entry drift</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">
                {finite(currentDrift) ? `${fmtPct(currentDrift, 2, true)} / max ${fmtPct(policy?.maxEntryDriftPct, 1)}` : EM_DASH}
              </dd>
            </dl>
            {pending.review?.alerts?.length ? (
              <ul className="mt-2 list-disc pl-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {pending.review.alerts.slice(0, 3).map((alert, i) => (
                  <li key={i}>{alert}</li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="rounded-lg border border-[color:var(--con-line)] p-3">
            <div className="con-card-title mb-2 flex items-center gap-1.5" title="Bracket reward:risk geometry from the persisted entry anchor, stop, and take-profit.">
              <TrendingUp size={12} /> Reward:risk geometry
            </div>
            {rewardRisk ? (
              <>
                <div className="mb-2 flex h-2 overflow-hidden rounded-full bg-[color:var(--con-line)]" aria-hidden>
                  <div className="bg-[color:var(--con-neg)]" style={{ flex: 1 }} />
                  <div className="bg-[color:var(--con-pos)]" style={{ flex: Math.min(4, rewardRisk.ratio) }} />
                </div>
                <div className="grid grid-cols-3 gap-2 text-[length:var(--con-fs-xs)]">
                  <div title="Persisted decision-time entry/reference price.">
                    <div className="text-[color:var(--con-faint)]">Entry</div>
                    <div className="con-num font-semibold">{fmtMoney(rewardRisk.entry)}</div>
                  </div>
                  <div title="Loss side of the bracket.">
                    <div className="text-[color:var(--con-faint)]">Risk</div>
                    <div className="con-num font-semibold text-[color:var(--con-neg)]">{fmtMoney(rewardRisk.risk)}</div>
                  </div>
                  <div title="Profit side of the bracket.">
                    <div className="text-[color:var(--con-faint)]">Reward</div>
                    <div className="con-num font-semibold text-[color:var(--con-pos)]">{fmtMoney(rewardRisk.reward)}</div>
                  </div>
                </div>
                <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                  R:R <strong className="con-num text-[color:var(--con-fg)]">{fmtNum(rewardRisk.ratio)}:1</strong> from stop{" "}
                  {fmtMoney(rewardRisk.stop)} to target {fmtMoney(rewardRisk.target)}.
                </p>
              </>
            ) : (
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                No complete opening bracket is attached to this proposal, so reward:risk is not computed.
              </p>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-[color:var(--con-line)] p-3">
          <div className="con-card-title mb-2 flex items-center gap-1.5" title="Decision-case evidence linked by proposal id.">
            <Database size={12} /> Evidence citations
          </div>
          {decisionCase?.ragAttributions?.length ? (
            <div className="flex flex-col gap-2">
              {decisionCase.ragAttributions.slice(0, 3).map((item, i) => (
                <div key={`${item.chunkId ?? item.title ?? item.source ?? "rag"}-${i}`} className="text-[length:var(--con-fs-xs)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone="accent" title={item.chunkId ? `Chunk ${item.chunkId}` : undefined}>
                      {evidenceLabel(item)}
                    </Chip>
                    {item.publishedAt && <span className="text-[color:var(--con-faint)]">{item.publishedAt}</span>}
                  </div>
                  <p className="mt-1 leading-relaxed text-[color:var(--con-muted)]">{item.contribution || item.title || item.text.slice(0, 160)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              No proposal-linked RAG citations are attached to this card yet. Served model and policy evidence are still persisted above.
            </p>
          )}
        </div>

        {/* Since proposed + revalidation */}
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <div className="con-card-title mb-1" title="Raw side-adjusted move since the proposal's reference price, not benchmark-relative. Positive means the idea has moved in the proposed direction.">
              Since proposed
            </div>
            {typeof pending.performanceSinceProposalPct === "number" ? (
              <p title="Raw proposal return since the decision-time reference price. It is not adjusted for SPY; benchmark-relative learning is handled separately in Results.">
                <SignedText value={pending.performanceSinceProposalPct}>{fmtPct(pending.performanceSinceProposalPct, 2, true)}</SignedText>{" "}
                <span className="text-[color:var(--con-faint)]">
                  in the proposed direction
                  {typeof pending.proposalReferencePrice === "number" && typeof pending.proposalCurrentPrice === "number"
                    ? ` (${fmtMoney(pending.proposalReferencePrice)} → ${fmtMoney(pending.proposalCurrentPrice)})`
                    : ""}
                </span>
              </p>
            ) : (
              <Dash />
            )}
          </div>
          <div>
            <div className="con-card-title mb-1">Last re-check</div>
            {pending.revalidationNote ? (
              <p className="text-[color:var(--con-muted)]">
                &ldquo;{pending.revalidationNote}&rdquo;{" "}
                <span className="text-[color:var(--con-faint)]">
                  <Ago iso={pending.lastRevalidatedAt} />
                </span>
              </p>
            ) : (
              <p className="text-[color:var(--con-faint)]">Not re-validated yet — the next run re-checks it.</p>
            )}
          </div>
        </div>

        {/* Gate status */}
        <div>
          <div className="con-card-title mb-1">Policy gate</div>
          {pending.decision.reasons.length > 0 ? (
            <ul className="list-disc pl-4 text-[color:var(--con-muted)]">
              {pending.decision.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[color:var(--con-muted)]">
              Passed every check when proposed. The full gate re-runs server-side at the moment you approve — with fresh
              prices, caps, and wash-sale state.
            </p>
          )}
          {pending.decision.washSale?.note && (
            <p
              className="mt-1 font-semibold text-[color:var(--con-warn)]"
              title="This account's Tax rules disregard IRA wash sales (Rev. Rul. 2008-5 would otherwise block this rebuy). The purchase is annotated and audited; disregarding is an audit-risk acceptance."
            >
              {pending.decision.washSale.note}
            </p>
          )}
        </div>

        {/* Three outcomes */}
        <div className="rounded-lg border border-[color:var(--con-line)] p-3 text-[length:var(--con-fs-xs)] leading-relaxed">
          <p>
            <strong>If you approve:</strong> {SIDE_LABEL[p.side]?.toLowerCase() ?? p.side} {sizeText} at {p.type.replace("_", " ")}
            {typeof p.limitPrice === "number" ? ` (limit ${fmtMoney(p.limitPrice)})` : ""}.
            {typeof p.bracketStopLoss === "number" || typeof p.bracketTakeProfit === "number" ? (
              <>
                {" "}
                Bracket protection: {typeof p.bracketStopLoss === "number" ? `stop ${fmtMoney(p.bracketStopLoss)}` : ""}
                {typeof p.bracketStopLoss === "number" && typeof p.bracketTakeProfit === "number" ? " · " : ""}
                {typeof p.bracketTakeProfit === "number" ? `take-profit ${fmtMoney(p.bracketTakeProfit)}` : ""}.
              </>
            ) : null}
            {live ? " This uses the broker-account approval phrase before anything is placed." : ""}
          </p>
          <p className="mt-1">
            <strong>If you reject:</strong> nothing is traded. The idea stays on the record and its counterfactual return
            keeps being measured.
          </p>
          <p className="mt-1">
            <strong>If you do nothing:</strong>{" "}
            {expiresAt ? (
              <>
                it expires {timeUntil(expiresAt)} and nothing is traded.
              </>
            ) : (
              "it stays pending until a run withdraws it or you decide."
            )}
          </p>
        </div>
      </div>

      {/* Actions */}
      <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--con-line)] px-4 py-3">
        <Btn variant="ghost" disabled={busy !== null} onClick={() => void reject()}>
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </Btn>
        {/* Approving a broker-connected order stays visually primary; the typed
            ritual in the sheet is the real friction. */}
        <Btn variant={live ? "primary" : "pos"} disabled={busy !== null} onClick={() => void approve()}>
          {busy === "approve" ? "Approving…" : live ? (
            <>
              Approve broker order… <LiveTag />
            </>
          ) : (
            "Approve"
          )}
        </Btn>
      </footer>

      {live && (
        <LiveApproveSheet
          open={liveOpen}
          onClose={() => setLiveOpen(false)}
          pending={pending}
          notional={notional}
          onDone={finish}
        />
      )}
    </article>
  );
}

/** The typed real-money confirmation. The server contract
 *  (assertLiveApprovalConfirmation) verifies: proposal id, account number,
 *  executionMode "broker/live", the reviewed estimated notional (±$0.01), and
 *  the exact phrase APPROVE LIVE <SYMBOL>. On mismatch the server answers 409
 *  with its reasons and the authoritative expected text — rendered verbatim. */
function LiveApproveSheet({
  open,
  onClose,
  pending,
  notional,
  onDone
}: {
  open: boolean;
  onClose: () => void;
  pending: PendingProposal;
  notional: number | undefined;
  onDone: (result: ApproveResult) => void;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverReasons, setServerReasons] = useState<string[]>([]);
  const [serverExpected, setServerExpected] = useState<string | null>(null);

  const expectedText = useMemo(
    () => serverExpected ?? `APPROVE LIVE ${pending.proposal.symbol.toUpperCase()}`,
    [serverExpected, pending.proposal.symbol]
  );
  const matches = typed.trim().toUpperCase() === expectedText;

  const submit = async () => {
    setBusy(true);
    try {
      const result = await approveProposal(pending.id, {
        proposalId: pending.id,
        accountNumber: pending.accountNumber ?? null,
        executionMode: "broker/live",
        estimatedNotional: notional ?? null,
        typedText: typed.trim().toUpperCase()
      });
      await refresh();
      onClose();
      setTyped("");
      setServerReasons([]);
      onDone(result);
    } catch (error) {
      if (error instanceof LiveConfirmationRequiredError) {
        // The server is the authority: show its reasons and its expected text.
        setServerReasons(error.reasons);
        setServerExpected(error.expectedText);
        setTyped("");
      } else {
        toast.push("neg", "Live approval failed", error instanceof ConsoleApiError ? error.message : String(error));
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Broker order approval">
      <div className="mb-3 rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-3 text-[length:var(--con-fs-sm)]">
        <div className="font-bold">Brokerage account</div>
        <p className="con-num mt-1">
          {SIDE_LABEL[pending.proposal.side] ?? pending.proposal.side.toUpperCase()} {pending.proposal.symbol} — estimated{" "}
          <strong>{fmtMoney(notional)}</strong>
          {pending.accountNumber ? ` from account ·· ${pending.accountNumber.slice(-4)}` : ""}
        </p>
        <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          The server re-checks everything at this moment — fresh price, entry drift, caps, wash-sale locks. If anything no
          longer passes, nothing is placed and you&apos;ll see the reasons here.
        </p>
      </div>

      {serverReasons.length > 0 && (
        <div className="mb-3 rounded-lg border border-[color:var(--con-warn-border)] p-3 text-[length:var(--con-fs-xs)]">
          <div className="font-semibold text-[color:var(--con-warn)]">The server refused the confirmation:</div>
          <ul className="mt-1 list-disc pl-4 text-[color:var(--con-muted)]">
            {serverReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="con-label" htmlFor={`live-typed-${pending.id}`}>
        Type exactly: <span className="con-mono text-[color:var(--con-fg)]">{expectedText}</span>
      </label>
      <TextInput
        id={`live-typed-${pending.id}`}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="characters"
        spellCheck={false}
        onPaste={(e) => e.preventDefault()}
        placeholder={expectedText}
        className="con-mono"
      />
      <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Paste is disabled on purpose — the words are the consent.</p>

      <div className="mt-4 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn variant="primary" disabled={!matches || busy} onClick={() => void submit()}>
          {busy ? "Placing…" : (
            <>
              Place broker order <LiveTag />
            </>
          )}
        </Btn>
      </div>
    </Sheet>
  );
}
