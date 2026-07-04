"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, BookOpen, Brain, Database, GitBranch, MessageSquare, Swords, TrendingUp } from "lucide-react";
import type { SocraticDecisionCase, SocraticEvidenceItem, SocraticFrameworkProposal, SocraticRagAttribution } from "@/lib/types";
import { fmtMoney, fmtPct, timeAgo, EM_DASH } from "../../lib/format";
import { Btn, Card, Chip, SignedText, TextArea } from "../../ui/primitives";
import { SymbolButton } from "../../ui/symbol-drilldown";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; decision: SocraticDecisionCase; framework: SocraticFrameworkProposal[] };

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

export default function DecisionTracePage() {
  const params = useParams<{ id: string }>();
  const decisionId = String(params.id ?? "");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    async () => {
      try {
        const [decisionRes, frameworkRes] = await Promise.all([
          fetch(`/api/socratic/decisions/${encodeURIComponent(decisionId)}`, { cache: "no-store" }),
          fetch("/api/socratic/framework?limit=100", { cache: "no-store" })
        ]);
        if (!decisionRes.ok) throw new Error(await decisionRes.text());
        const decision = (await decisionRes.json()) as SocraticDecisionCase;
        const framework = frameworkRes.ok ? ((await frameworkRes.json()) as SocraticFrameworkProposal[]) : [];
        setState({
          status: "ready",
          decision,
          framework: framework.filter((proposal) => proposal.decisionId === decision.id)
        });
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "Could not load decision trace." });
      }
    },
    [decisionId]
  );

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const saveNote = async () => {
    const trimmed = note.trim();
    if (!trimmed || state.status !== "ready") return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/socratic/decisions/${encodeURIComponent(state.decision.id)}/coach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: trimmed })
      });
      if (!response.ok) throw new Error(await response.text());
      setNote("");
      setMessage("Saved to this decision case.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save note.");
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") {
    return (
      <div className="mx-auto max-w-5xl">
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Loading decision trace...</p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mx-auto max-w-3xl">
        <Link href="/console" className="mb-4 inline-flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
          <ArrowLeft size={13} /> Back to console
        </Link>
        <Card>
          <p className="text-[color:var(--con-warn)]">{state.message}</p>
        </Card>
      </div>
    );
  }

  const { decision, framework } = state;
  const outcome = decision.outcome;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/console" className="inline-flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
          <ArrowLeft size={13} /> Back to console
        </Link>
        <div className="flex flex-wrap gap-2">
          <Chip tone="accent" title="Decision status persisted on the Socratic case file.">
            {decision.status}
          </Chip>
          <Chip tone="muted" title="Authority mode at decision time.">
            {decision.authority}
          </Chip>
          {decision.updatedAt && (
            <Chip tone="muted" title={new Date(decision.updatedAt).toLocaleString()}>
              updated {timeAgo(decision.updatedAt)}
            </Chip>
          )}
        </div>
      </div>

      <section className="con-thesis-hero">
        <div className="min-w-0">
          <div className="con-card-title flex items-center gap-1.5">
            <Brain size={13} /> Decision trace
          </div>
          <h1>{decision.thesis || `${decision.symbol ?? "Portfolio"} decision`}</h1>
          <p>{decision.rationale || "No rationale is attached to this case."}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {decision.symbol && (
              <Chip tone="accent">
                {decision.side ? `${SIDE_LABEL[decision.side] ?? decision.side.toUpperCase()} ` : ""}
                <SymbolButton symbol={decision.symbol} showLogo={false} className="text-inherit" />
              </Chip>
            )}
            {decision.thesisTag && <Chip tone="muted">{decision.thesisTag}</Chip>}
            {decision.regime && <Chip tone="muted">{decision.regime}</Chip>}
            {typeof decision.confidenceScore === "number" && <Chip tone="pos">confidence {decision.confidenceScore}</Chip>}
          </div>
        </div>

        <div className="con-autonomy-card">
          <div className="con-card-title">Action</div>
          <div className="mt-1 text-[length:var(--con-fs-xl)] font-semibold">{decision.action || EM_DASH}</div>
          <p>
            {fmtMoney(decision.notional)}
            {decision.model ? ` · ${decision.model}` : ""}
          </p>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <div className="flex flex-col gap-4">
          <TraceSection icon={<Database size={13} />} title="Evidence">
            <EvidenceList items={decision.evidence} empty="No structured evidence items are attached to this case yet." />
          </TraceSection>

          <TraceSection icon={<BookOpen size={13} />} title="Retrieved citations">
            {decision.ragAttributions.length > 0 ? (
              <div className="flex flex-col gap-2">
                {decision.ragAttributions.map((item, index) => (
                  <RagItem key={`${item.chunkId ?? item.title ?? item.source ?? "rag"}-${index}`} item={item} />
                ))}
              </div>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No retrieved citations are linked to this case yet.
              </p>
            )}
          </TraceSection>

          <TraceSection icon={<Swords size={13} />} title="Dissent">
            {decision.redTeamVerdict?.available && (
              <article className="con-evidence-card con-evidence-warn">
                <div className="flex items-start justify-between gap-3">
                  <strong>Red Team</strong>
                  <span>{redTeamTriggerLabel(decision.redTeamVerdict.trigger)}</span>
                </div>
                <p>{decision.redTeamVerdict.reason}</p>
              </article>
            )}
            <EvidenceList items={decision.dissent} empty={decision.redTeamVerdict?.available ? "" : "No dissent items are attached to this case yet."} />
          </TraceSection>
        </div>

        <aside className="flex flex-col gap-4">
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <TrendingUp size={13} /> Outcome
              </span>
            }
          >
            {outcome ? (
              <div className="grid gap-3 text-[length:var(--con-fs-sm)]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[color:var(--con-faint)]">Status</span>
                  <strong>{outcome.status}</strong>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[color:var(--con-faint)]">Return</span>
                  <strong>{typeof outcome.returnPct === "number" ? <SignedText value={outcome.returnPct}>{fmtPct(outcome.returnPct, 2, true)}</SignedText> : EM_DASH}</strong>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[color:var(--con-faint)]">P&amp;L</span>
                  <strong>{fmtMoney(outcome.pnlUsd)}</strong>
                </div>
                {outcome.note && <p className="text-[color:var(--con-muted)]">{outcome.note}</p>}
              </div>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No matured outcome history is attached to this case yet.
              </p>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <MessageSquare size={13} /> Coach on this trace
              </span>
            }
          >
            {decision.coachNotes.length > 0 ? (
              <div className="mb-3 flex flex-col gap-2">
                {decision.coachNotes.slice(-4).map((coachNote, index) => (
                  <p key={`${coachNote}-${index}`} className="rounded-md border border-[color:var(--con-line)] p-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                    {coachNote}
                  </p>
                ))}
              </div>
            ) : null}
            <TextArea
              rows={4}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What should Socratic Trade remember about this decision?"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Btn variant="primary" size="sm" disabled={busy || !note.trim()} onClick={() => void saveNote()}>
                <MessageSquare size={14} /> Save note
              </Btn>
              {message && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{message}</span>}
            </div>
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <GitBranch size={13} /> Framework proposals
              </span>
            }
          >
            {framework.length > 0 ? (
              <div className="flex flex-col gap-2">
                {framework.map((proposal) => (
                  <article key={proposal.id} className="con-evidence-card con-evidence-accent">
                    <div className="flex items-start justify-between gap-3">
                      <strong>{proposal.title}</strong>
                      <span>{proposal.status}</span>
                    </div>
                    <p>{proposal.proposedChange}</p>
                    {proposal.ownerResponse && <p className="mt-1 text-[color:var(--con-faint)]">Owner: {proposal.ownerResponse}</p>}
                  </article>
                ))}
              </div>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No framework proposal is linked to this decision yet.
              </p>
            )}
          </Card>

          <Card title="Lessons">
            {decision.lessons.length > 0 ? (
              <ul className="list-disc pl-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                {decision.lessons.map((lesson, index) => (
                  <li key={`${lesson}-${index}`}>{lesson}</li>
                ))}
              </ul>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">No durable lessons are attached yet.</p>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

function TraceSection({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          {icon} {title}
        </span>
      }
    >
      {children}
    </Card>
  );
}

function EvidenceList({ items, empty }: { items: SocraticEvidenceItem[]; empty: string }) {
  if (items.length === 0) {
    return empty ? <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">{empty}</p> : null;
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => (
        <article key={`${item.kind}-${item.title}-${index}`} className={`con-evidence-card con-evidence-${toneFromSocratic(item.tone)}`}>
          <div className="flex items-start justify-between gap-3">
            <strong>{item.title}</strong>
            <span>{[item.kind, item.source].filter(Boolean).join(" · ")}</span>
          </div>
          <p>{item.summary}</p>
        </article>
      ))}
    </div>
  );
}

function RagItem({ item }: { item: SocraticRagAttribution }) {
  const meta = [item.docType, item.source, typeof item.score === "number" ? `score ${item.score.toFixed(2)}` : item.symbol].filter(Boolean).join(" · ");
  return (
    <article className="con-evidence-card con-evidence-accent">
      <div className="flex items-start justify-between gap-3">
        <strong>{item.title || item.chunkId || "Retrieved evidence"}</strong>
        <span>{meta}</span>
      </div>
      <p>{item.contribution || item.text}</p>
      {item.url && (
        <a className="mt-2 inline-flex text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]" href={item.url} target="_blank" rel="noreferrer">
          Source
        </a>
      )}
    </article>
  );
}

function toneFromSocratic(tone: SocraticEvidenceItem["tone"]): "pos" | "warn" | "neg" | "accent" {
  if (tone === "positive") return "pos";
  if (tone === "negative") return "neg";
  if (tone === "warning") return "warn";
  return "accent";
}

function redTeamTriggerLabel(trigger: NonNullable<SocraticDecisionCase["redTeamVerdict"]>["trigger"]): string {
  if (trigger === "confidence") return "confidence";
  if (trigger === "notional") return "large notional";
  if (trigger === "live_opening") return "live opening";
  if (trigger === "override_requested") return "override request";
  if (trigger === "escalation_regime") return "risk regime";
  return "legacy trigger";
}
