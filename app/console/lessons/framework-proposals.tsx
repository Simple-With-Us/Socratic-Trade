"use client";

/** Framework proposals surface shared by the console Home and the Lessons page
 *  (W25 / OD-11). Extracted from app/console/page.tsx so the proposal list no
 *  longer exists only on Home: Lessons now carries the same full review
 *  surface — pending counts, AI review, accept/rewrite/applied/reject — with
 *  an honest empty state when none exist. */

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Brain, Check, GitBranch, MessageSquare, RotateCcw, X } from "lucide-react";
import type { SocraticFrameworkProposal } from "@/lib/types";
import { frameworkStatusLabel } from "../lib/labels";
import { useConsoleActions, useConsoleSnapshotOptional } from "../lib/useConsoleData";
import { Card, Chip } from "../ui/primitives";

export function FrameworkProposalList({ proposals, refresh }: { proposals: SocraticFrameworkProposal[]; refresh: () => Promise<void> }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);

  const pendingCount = proposals.filter((p) => p.status === "pending").length;

  const runAiReview = async () => {
    setReviewing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/socratic/framework/review", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { reviewed?: number; skippedReason?: string };
      await refresh();
      setMessage(
        data.reviewed
          ? `AI reviewed ${data.reviewed} pending proposal${data.reviewed === 1 ? "" : "s"}.`
          : data.skippedReason === "no_pending"
            ? "No pending proposals to review."
            : data.skippedReason === "no_llm_key"
              ? "AI review needs an LLM key configured."
              : data.skippedReason === "over_budget"
                ? "AI review skipped: LLM budget spent."
                : "AI review produced no recommendations."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not run AI review.");
    } finally {
      setReviewing(false);
    }
  };

  const update = async (
    proposal: SocraticFrameworkProposal,
    status: "pending" | "accepted" | "rejected" | "applied",
    ownerVerb?: "accept" | "reject" | "rewrite"
  ) => {
    setBusyId(proposal.id);
    setMessage(null);
    try {
      const ownerResponse = responses[proposal.id]?.trim();
      const res = await fetch(`/api/socratic/framework/${encodeURIComponent(proposal.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status,
          ...(ownerVerb ? { ownerVerb } : {}),
          ...(ownerResponse ? { ownerResponse } : {})
        })
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update proposal.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          Learning proposals across all accounts{pendingCount > 0 ? ` · ${pendingCount} shown pending` : ""}
        </span>
        {/* Not gated on the shown pendingCount: this list is truncated to the 25 most recent
            (mixed status), but the review route works on the FULL pending backlog server-side —
            so keep the button live whenever we're not already reviewing. */}
        <button
          type="button"
          className="con-btn con-btn-outline con-btn-sm"
          disabled={reviewing}
          onClick={() => void runAiReview()}
          title="Review every pending proposal (across all accounts) in a single LLM call and attach an advisory recommendation to each."
        >
          <Brain size={14} /> {reviewing ? "Reviewing…" : "AI review pending"}
        </button>
      </div>
      <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
        <strong>Accept</strong> = agree this change should be made (intent only — nothing auto-implements).{" "}
        <strong>Applied</strong> = you already put that change into policy/prompt/code.{" "}
        <strong>Rewrite</strong> = accept your edited text.{" "}
        <strong>Reject</strong> = discard.  Decisions can be changed anytime.
      </p>
      {proposals.slice(0, 25).map((proposal) => {
        const responseText = (responses[proposal.id] ?? proposal.ownerResponse ?? "").trim();
        const busy = busyId === proposal.id;
        return (
        <article key={proposal.id} className="con-evidence-card con-evidence-accent">
          <div className="flex items-start justify-between gap-3">
            <strong>{proposal.title}</strong>
            <span>{frameworkStatusLabel(proposal.status)}</span>
          </div>
          <p>{proposal.proposedChange}</p>
          {proposal.aiReview && (
            <div className="mt-2 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-xs)]">
              <div className="flex items-center gap-2 font-semibold">
                <Brain size={13} /> AI recommends: {proposal.aiReview.verdict}
              </div>
              <p className="mt-1 text-[color:var(--con-muted)]">{proposal.aiReview.rationale}</p>
              {proposal.aiReview.verdict === "rewrite" && proposal.aiReview.rewrittenChange && (
                <div className="mt-2">
                  <p className="text-[color:var(--con-fg)]">{proposal.aiReview.rewrittenChange}</p>
                  <button
                    type="button"
                    className="con-btn con-btn-outline con-btn-sm mt-2"
                    disabled={busy}
                    onClick={() => setResponses((current) => ({ ...current, [proposal.id]: proposal.aiReview!.rewrittenChange ?? "" }))}
                  >
                    <MessageSquare size={13} /> Use suggested rewrite
                  </button>
                </div>
              )}
            </div>
          )}
          <textarea
            className="con-textarea mt-3"
            rows={3}
            value={responses[proposal.id] ?? proposal.ownerResponse ?? ""}
            onChange={(event) => setResponses((current) => ({ ...current, [proposal.id]: event.target.value }))}
            placeholder="Owner response or rewrite"
          />
          {proposal.ownerResponse && (
            <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              {proposal.ownerVerb ? `${proposal.ownerVerb}: ` : "Owner: "}
              {proposal.ownerResponse}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="con-btn con-btn-pos con-btn-sm"
              disabled={busy}
              title="Agree this proposed change should be made.  Does not auto-edit policy or prompts."
              onClick={() => void update(proposal, "accepted", "accept")}
            >
              <Check size={14} /> Accept
            </button>
            <button
              type="button"
              className="con-btn con-btn-outline con-btn-sm"
              disabled={busy || !responseText}
              title="Accept using the text in Owner response as the rewritten proposed change."
              onClick={() => void update(proposal, "accepted", "rewrite")}
            >
              <MessageSquare size={14} /> Rewrite
            </button>
            <button
              type="button"
              className="con-btn con-btn-outline con-btn-sm"
              disabled={busy || (proposal.status !== "accepted" && proposal.status !== "applied")}
              title="Mark that you already implemented the accepted change (policy, prompt, or code)."
              onClick={() => void update(proposal, "applied")}
            >
              <GitBranch size={14} /> Applied
            </button>
            <button
              type="button"
              className="con-btn con-btn-danger-outline con-btn-sm"
              disabled={busy}
              title="Discard this proposal.  You can change your mind later."
              onClick={() => void update(proposal, "rejected", "reject")}
            >
              <X size={14} /> Reject
            </button>
            {proposal.status !== "pending" && (
              <button
                type="button"
                className="con-btn con-btn-outline con-btn-sm"
                disabled={busy}
                title="Return this proposal to Pending so it can be re-reviewed."
                onClick={() => void update(proposal, "pending")}
              >
                <RotateCcw size={14} /> Reopen
              </button>
            )}
          </div>
        </article>
        );
      })}
      {message && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{message}</span>}
    </div>
  );
}

/** Lessons-page panel wrapping the shared list (W25 / OD-11): the framework
 *  proposals used to render only on Home; Lessons now carries the same review
 *  surface with a pending badge and an honest empty state. */
export function FrameworkProposalsPanel() {
  const snapshot = useConsoleSnapshotOptional();
  const { refresh } = useConsoleActions();
  const proposals = snapshot?.socratic?.frameworkProposals ?? [];
  const pendingCount = proposals.filter((p) => p.status === "pending").length;

  return (
    <section id="framework-proposals" className="scroll-mt-28">
      <Card
        title={
          <span className="flex items-center gap-2">
            <GitBranch size={13} /> Framework Improvements
            {pendingCount > 0 && <Chip tone="warn">{pendingCount} pending</Chip>}
          </span>
        }
        action={
          <Link
            href="/console/strategy"
            className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]"
          >
            Strategy <ArrowRight size={12} />
          </Link>
        }
      >
        {proposals.length > 0 ? (
          <FrameworkProposalList proposals={proposals} refresh={refresh} />
        ) : (
          <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            No framework proposals yet.{"\u00A0"} Once a run or review proposes a framework change, it shows up here for your judgment.
          </p>
        )}
      </Card>
    </section>
  );
}