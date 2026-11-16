"use client";

/** A trade draft the assistant produced, rendered as a compact order ticket.
 *
 *  Improved handoff vs the legacy assistant: the policy dry-run preview runs
 *  automatically when the ticket appears (no extra click), and staging hands
 *  off to the console's Approvals screen — the one decision surface — instead
 *  of duplicating an approve/reject rail inside chat. The dry-run is a PREVIEW:
 *  the authoritative policy check re-runs at approval time (and a block that is
 *  staleness-only still stages — the server folds that into its decision). */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { ChatDraft } from "@/lib/chat/types";
import type { RealityInfo } from "../lib/derive";
import { fmtMoney } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { Btn, Chip, Tooltip } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";
import { useToast } from "../ui/toast";

interface Decision {
  approved: boolean;
  reasons: string[];
}

type Phase = "checking" | "ready" | "staging" | "staged" | "discarded";

async function readBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function reasonsFrom(body: Record<string, unknown>, fallback: string): string[] {
  if (Array.isArray(body.reasons) && body.reasons.length > 0) return body.reasons.map(String);
  if (typeof body.error === "string" && body.error) return [body.error];
  return [fallback];
}

/** The reality/account scope a proposal was staged under, frozen at stage()
 *  time. Once the proposal exists it is a fact about THAT scope — the ticket
 *  must keep describing it even if the console is later switched to a
 *  different account. */
interface StagedScope {
  scopeKey: string;
  word: RealityInfo["word"];
  phrase: RealityInfo["phrase"];
  tone: RealityInfo["tone"];
  clarification: string;
  accountLabel: string;
}

export function DraftTicket({ draft, reality }: { draft: ChatDraft; reality: RealityInfo }) {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("checking");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [estimatedNotional, setEstimatedNotional] = useState<number | undefined>(undefined);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [stagedScope, setStagedScope] = useState<StagedScope | null>(null);

  // Stable key for the account/policy scope this preview is computed under.
  // Switching the active account rescopes the server-side policy evaluation,
  // so a verdict computed for the previous account must not keep presenting
  // "Stage" under the new reality chip (worst case: a stale PAPER verdict shown
  // right after a switch to LIVE). Memoized on stable ids — not snapshot
  // object identity — so the 15s poll never re-triggers it; only a real
  // scope change does.
  const activeAccount = snapshot?.connectedAccounts.find((a) => a.isActive);
  const activeAccountId = activeAccount?.id;
  const accountNumber = snapshot?.policy.accountNumber;
  const scopeKey = useMemo(
    () => `${activeAccountId ?? "no-account"}:${accountNumber ?? ""}:${reality.mode}`,
    [activeAccountId, accountNumber, reality.mode]
  );

  // Monotonic id per preview run. Preview responses can resolve out of order
  // (rapid scope flips, manual Re-check during an auto run), and staging or
  // discarding must invalidate any preview still in flight — only the LATEST
  // run may write decision/estimate/phase.
  const previewGenRef = useRef(0);

  const runPreview = useCallback(async () => {
    const gen = ++previewGenRef.current;
    setPhase("checking");
    setPreviewError(null);
    setDecision(null); // never show a verdict from another scope while re-checking
    setEstimatedNotional(undefined);
    try {
      const res = await fetch("/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, dryRun: true })
      });
      const body = await readBody(res);
      if (gen !== previewGenRef.current) return; // superseded by a newer run / stage / discard
      if (!res.ok) {
        setDecision({ approved: false, reasons: reasonsFrom(body, `Policy preview failed (${res.status}).`) });
        setEstimatedNotional(undefined);
      } else {
        const d = body.decision as Decision | undefined;
        setDecision(d && typeof d.approved === "boolean" ? d : null);
        setEstimatedNotional(typeof body.estimatedNotional === "number" ? body.estimatedNotional : undefined);
      }
    } catch {
      if (gen !== previewGenRef.current) return;
      // Network failure of the PREVIEW only — staging stays available because the
      // server re-checks policy authoritatively on commit and again at approval.
      setDecision(null);
      setPreviewError("Policy preview unreachable right now.  You can still stage — the server re-checks before anything is created.");
    }
    if (gen !== previewGenRef.current) return;
    setPhase("ready");
  }, [draft]);

  // Run the preview on mount AND whenever the account scope changes; the
  // comparison against the last previewed scope happens INSIDE the effect (no
  // render-time ref access). Once the draft is staged (a proposal exists —
  // that's a fact about the OLD scope) or discarded, or while a commit is in
  // flight, a scope flip must not restart the preview and wipe that state.
  const lastPreviewScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (phase === "staged" || phase === "discarded" || phase === "staging") return;
    if (lastPreviewScopeRef.current === scopeKey) return;
    lastPreviewScopeRef.current = scopeKey;
    void runPreview();
  }, [phase, scopeKey, runPreview]);

  const stage = async () => {
    previewGenRef.current += 1; // invalidate any preview still in flight
    setPhase("staging");
    try {
      const res = await fetch("/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft })
      });
      const body = await readBody(res);
      if (res.ok && typeof body.proposalId === "string") {
        setProposalId(body.proposalId);
        if (typeof body.estimatedNotional === "number") setEstimatedNotional(body.estimatedNotional);
        // Freeze the scope this proposal was actually created under.
        setStagedScope({
          scopeKey,
          word: reality.word,
          phrase: reality.phrase,
          tone: reality.tone,
          clarification: reality.clarification,
          accountLabel: activeAccount?.label || activeAccount?.broker || "No connected account"
        });
        setPhase("staged");
        toast.push(
          "pos",
          body.deduped ? "Already staged" : "Staged for approval",
          "Review it in Approvals — nothing places until you approve it there."
        );
        void refresh(); // bump the Approvals badge right away
        return;
      }
      const reasons = reasonsFrom(body, `Could not stage (${res.status}).`);
      setDecision({ approved: false, reasons });
      setPhase("ready");
      toast.push("warn", "Blocked by policy", reasons.join(" "));
    } catch (e) {
      setPhase("ready");
      toast.push("neg", "Staging failed", e instanceof Error ? e.message : "Network error — try again.");
    }
  };

  const discard = () => {
    previewGenRef.current += 1; // a late preview must not revive a discarded card
    setPhase("discarded");
  };

  if (phase === "discarded") {
    return (
      <div className="mt-2 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface)] px-3 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
        Draft discarded.  Nothing was created.
      </div>
    );
  }

  const sideUp = draft.side.toUpperCase();
  const limitText = draft.order_type === "limit" && draft.limit_usd != null ? ` @ ${fmtMoney(draft.limit_usd)}` : "";
  const blocked = decision !== null && !decision.approved;
  // Once staged, the ticket describes the scope it was staged under (frozen at
  // stage() time) — never the console's current scope.
  const shownScope = stagedScope ?? {
    scopeKey,
    word: reality.word,
    phrase: reality.phrase,
    tone: reality.tone,
    clarification: reality.clarification,
    accountLabel: activeAccount?.label || activeAccount?.broker || "No connected account"
  };
  const stagedElsewhere = stagedScope !== null && stagedScope.scopeKey !== scopeKey;
  const stagedLive = stagedScope?.tone === "live";

  return (
    <div className="mt-2 rounded-control border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tooltip className="con-mono text-[length:var(--con-fs-sm)] font-semibold" content="The order the assistant drafted.  It is only a draft until you stage and then approve it.">
          {sideUp} {draft.qty} <SymbolButton symbol={draft.symbol} className="font-mono text-inherit" /> · {draft.order_type}
          {limitText}
        </Tooltip>
        <Chip
          tone={shownScope.tone}
          title={
            stagedScope
              ? `The money-reality this proposal was STAGED under. ${shownScope.clarification}`
              : shownScope.clarification
          }
        >
          {shownScope.word} · {shownScope.phrase}
        </Chip>
      </div>
      {draft.rationale && <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{draft.rationale}</p>}
      {draft.warnings.length > 0 && (
        <Tooltip
          className="mt-1.5"
          content="Cautions the assistant itself attached to this draft."
        >
          <ul className="space-y-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
            {draft.warnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        </Tooltip>
      )}

      {/* Policy preview result */}
      {phase === "checking" && (
        <div className="mt-2 flex items-center gap-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          <Loader2 size={13} className="animate-spin" /> Checking against your guardrails…
        </div>
      )}
      {phase !== "checking" && decision && (
        <Tooltip
          className="mt-2"
          content={
            blocked
              ? "Your policy guardrails would refuse this order as things stand now."
              : "A preview check against your policy guardrails.  The authoritative check re-runs when you approve."
          }
        >
          <div
            className="rounded-control px-2.5 py-1.5 text-[length:var(--con-fs-xs)]"
            style={{
              background: blocked ? "var(--con-neg-soft)" : "var(--con-pos-soft)",
              color: blocked ? "var(--con-neg)" : "var(--con-pos)"
            }}
          >
            <div className="flex flex-wrap items-center gap-1.5 font-semibold">
              {blocked ? <AlertTriangle size={13} /> : <ShieldCheck size={13} />}
              {blocked ? "Blocked by policy" : "Passes policy preview"}
              {estimatedNotional !== undefined && (
                <Tooltip
                  className="con-num font-normal text-[color:var(--con-muted)]"
                  content="Estimated order value from the broker's pre-trade review.  Final numbers are re-checked at approval time."
                >
                  · est. {fmtMoney(estimatedNotional)}
                </Tooltip>
              )}
            </div>
            {blocked && decision.reasons.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {decision.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        </Tooltip>
      )}
      {phase !== "checking" && previewError && (
        <Tooltip
          className="mt-2 rounded-control bg-[color:var(--con-warn-soft)] px-2.5 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
          content="Only the preview failed.  Staging still runs the real policy check on the server."
        >
          <AlertTriangle size={13} className="mr-1.5 inline-block align-[-2px]" />
          {previewError}
        </Tooltip>
      )}

      {/* Actions */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {phase === "ready" && !blocked && (
          <Tooltip content="Creates a pending proposal in Approvals.  Nothing is bought or sold until you approve it there.">
            <Btn
              size="sm"
              variant="primary"
              onClick={() => void stage()}
            >
              Stage for approval <ArrowRight size={13} />
            </Btn>
          </Tooltip>
        )}
        {phase === "staging" && (
          <span className="flex items-center gap-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
            <Loader2 size={13} className="animate-spin" /> Staging…
          </span>
        )}
        {phase === "ready" && (
          <Tooltip content="Run the policy preview again — guardrails, account state, or prices may have changed.">
            <Btn
              size="sm"
              variant="ghost"
              onClick={() => void runPreview()}
            >
              <RefreshCw size={13} /> Re-check
            </Btn>
          </Tooltip>
        )}
        {(phase === "ready" || phase === "staging") && (
          <Tooltip content="Dismiss this draft.  It only removes the card — nothing was created yet.">
            <Btn
              size="sm"
              variant="ghost"
              disabled={phase === "staging"}
              onClick={discard}
            >
              <X size={13} /> Discard
            </Btn>
          </Tooltip>
        )}
        {phase === "staged" && proposalId && (
          <>
            <span className="flex items-center gap-1.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-pos)]">
              <Check size={13} /> Staged for approval
            </span>
            <Tooltip
              content={
                stagedLive
                  ? "Open the Approvals screen.  Approving there places a broker order."
                  : "Open the Approvals screen to approve or reject this proposal."
              }
            >
              <Link
                href="/console/approvals"
                className="con-btn con-btn-outline con-btn-sm"
              >
                Review in Approvals <ArrowRight size={13} />
              </Link>
            </Tooltip>
            {stagedElsewhere ? (
              <Tooltip
                className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]"
                content="Approvals shows the ACTIVE account's proposals, so this one is not visible under the account the console is currently scoped to."
              >
                Staged on {shownScope.accountLabel} ({shownScope.word} · {shownScope.phrase}) — the console has since
                switched accounts. Switch back to that account to review it in Approvals.
              </Tooltip>
            ) : (
              <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                {stagedLive ? "Approving there places a real-money order." : "Nothing places until you approve it there."}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
