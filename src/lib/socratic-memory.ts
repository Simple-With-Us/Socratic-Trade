import { createHash } from "crypto";
import type { ContextDocument, StoreContextsResult } from "./vector-db";
import type { SocraticDecisionCase, SocraticEvidenceItem, SocraticRagAttribution } from "./types";

// Every lifecycle update targets one stable Pinecone identity. Keep writes for a decision ordered
// inside this process so a slow older embed cannot finish after a newer terminal-state embed and
// overwrite it. Each queued write re-reads the current durable case, which also coalesces bursts of
// placing/placed/outcome updates onto the newest SQLite truth.
const decisionIndexQueues = new Map<string, Promise<StoreContextsResult>>();

function compact(value: string | undefined, fallback: string = "n/a"): string {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function summarizeEvidence(items: SocraticEvidenceItem[], fallback: string): string {
  const summaries = items
    .slice(0, 5)
    .map((item) => `${compact(item.title)}: ${compact(item.summary)}`)
    .filter(Boolean);
  return summaries.length > 0 ? summaries.join(" | ") : fallback;
}

function summarizeRag(items: SocraticRagAttribution[]): string {
  const summaries = items
    .slice(0, 5)
    .map((item) => {
      const source = compact(item.source ?? item.docType, "retrieved context");
      const score = typeof item.score === "number" ? ` score=${item.score.toFixed(3)}` : "";
      return `${source}${score}: ${compact(item.contribution || item.text)}`;
    })
    .filter(Boolean);
  return summaries.length > 0 ? summaries.join(" | ") : "No retrieved memory/context was attached to this case.";
}

function finalAction(decision: SocraticDecisionCase): string {
  return decision.status.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function buildSocraticMemoryDocument(
  decision: SocraticDecisionCase,
  accountEnvironment?: "paper" | "live",
  options?: { fmpRightsGeneration?: number; fmpProviderVectorId?: string }
): ContextDocument {
  const hasFmpRightsGeneration = options?.fmpRightsGeneration !== undefined;
  const hasFmpProviderVectorId = options?.fmpProviderVectorId !== undefined;
  if (hasFmpRightsGeneration !== hasFmpProviderVectorId) {
    throw new Error("FMP-derived Socratic memory requires both rights generation and provider vector ID.");
  }
  const symbol = decision.symbol ?? "PORTFOLIO";
  const criticCounterArgument =
    decision.redTeamVerdict?.reason ??
    summarizeEvidence(decision.dissent, "No explicit critic objection was recorded.");
  const policyOutcome = decision.policyDecision?.approved
    ? "approved"
    : `blocked: ${(decision.policyDecision?.reasons ?? []).join(" | ") || "n/a"}`;
  const override = decision.autonomyOverride
    ? `requested=${decision.autonomyOverride.requested === true}; applied=${decision.autonomyOverride.applied}; thesis=${compact(decision.autonomyOverride.thesis)}; conflicts=${decision.autonomyOverride.conflicts.join(" | ") || "n/a"}`
    : "none";
  // Multi-horizon outcome ladder (15m/1h/1d/1w). Each row is either a measured, SPY-relative
  // return or an HONEST 'unresolvable(reason)' — rendered so retrieval-time readers see coverage,
  // not just the survivors. Re-indexed by the outcome engine on every lifecycle update.
  const horizonText = (decision.outcome?.outcomes ?? [])
    .map((row) =>
      row.resolution === "ok"
        ? `${row.horizon} ${typeof row.returnPct === "number" ? `${row.returnPct >= 0 ? "+" : ""}${row.returnPct}%` : "n/a"}${
            typeof row.spyExcessPct === "number" ? ` (vs SPY ${row.spyExcessPct >= 0 ? "+" : ""}${row.spyExcessPct}%)` : ""
          }`
        : `${row.horizon} unresolvable(${row.reason ?? "unknown"})`
    )
    .join(", ");
  const outcome = decision.outcome
    ? `${decision.outcome.status}${typeof decision.outcome.returnPct === "number" ? `; return_pct=${decision.outcome.returnPct}` : ""}${typeof decision.outcome.pnlUsd === "number" ? `; pnl_usd=${decision.outcome.pnlUsd}` : ""}${horizonText ? `; horizons: ${horizonText}` : ""}${decision.outcome.note ? `; note=${compact(decision.outcome.note)}` : ""}`
    : "pending";

  const text = [
    "Socratic institutional memory case",
    `ticker: ${symbol}`,
    `timestamp: ${decision.createdAt}`,
    `final_action: ${finalAction(decision)}`,
    `side: ${decision.side ?? "n/a"}`,
    `authority: ${decision.authority}`,
    `thesis_tag: ${decision.thesisTag ?? "n/a"}`,
    `entry_market_regime: ${decision.regime ?? "n/a"}`,
    // Legacy rationale strings may contain an appended Red critique. Keep the institutional-memory
    // Green argument clean whenever the structured Green text exists; Red has its own field below.
    `broker_argument: ${compact(decision.thesis)} -- ${compact(decision.greenTeamRationale ?? decision.rationale)}`,
    `critic_counter_argument: ${compact(criticCounterArgument)}`,
    `policy_outcome: ${policyOutcome}`,
    `autonomy_override: ${override}`,
    `rag_contribution: ${summarizeRag(decision.ragAttributions)}`,
    `evidence: ${summarizeEvidence(decision.evidence, "No structured evidence was attached.")}`,
    `outcome: ${outcome}`,
    `lessons: ${decision.lessons.length > 0 ? decision.lessons.map((lesson) => compact(lesson)).join(" | ") : "pending"}`,
    `coach_notes: ${decision.coachNotes.length > 0 ? decision.coachNotes.map((note) => compact(note)).join(" | ") : "none"}`
  ].join("\n");

  return {
    text,
    metadata: {
      symbol,
      source: "socratic-memory",
      timestamp: decision.createdAt,
      accession: decision.id,
      doc_type: "socratic-decision",
      memory_scope: "account",
      decision_id: decision.id,
      final_action: finalAction(decision),
      ...(hasFmpRightsGeneration ? {
        vector_id: options!.fmpProviderVectorId!,
        fmp_derived: true,
        fmp_rights_generation: options!.fmpRightsGeneration
      } : {}),
      ...(decision.proposalId ? { proposal_id: decision.proposalId } : {}),
      ...(decision.runId ? { run_id: decision.runId } : {}),
      ...(decision.side ? { side: decision.side } : {}),
      authority: decision.authority,
      ...(decision.thesisTag ? { thesis_tag: decision.thesisTag } : {}),
      ...(decision.regime ? { entry_market_regime: decision.regime } : {}),
      ...(decision.connectedAccountId ? { connected_account_id: decision.connectedAccountId } : {}),
      ...(accountEnvironment ? {
        account_environment: accountEnvironment,
        transfer_state: "not_applicable"
      } : {})
    }
  };
}

/** A licensed decision generation gets its own immutable provider identity. */
export async function fmpDerivedSocraticMemoryVectorId(
  decision: Pick<SocraticDecisionCase, "id" | "userId">,
  generation: number
): Promise<string> {
  const digestBytes = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${decision.userId}\u0000${decision.id}\u0000${generation}`)
  );
  const digest = Array.from(
    new Uint8Array(digestBytes),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
  return `fmp-derived-socratic:v1:${digest}`;
}

/**
 * Persist a lesson string as `doc_type: lesson` so episodic retrieval can surface durable lessons
 * (not only SQL learned_context facts).
 */
export async function indexLessonMemory(input: {
  decision: SocraticDecisionCase;
  lesson: string;
  lessonIndex: number;
}): Promise<StoreContextsResult | undefined> {
  const lesson = input.lesson.replace(/\s+/g, " ").trim();
  if (!lesson) return undefined;
  try {
    const { storeContexts } = await import("./vector-db");
    const symbol = input.decision.symbol ?? "PORTFOLIO";
    const accession = `${input.decision.id}:lesson:${input.lessonIndex}`;
    const text = [
      "Durable lesson from a Socratic decision case",
      `ticker: ${symbol}`,
      `decision_id: ${input.decision.id}`,
      `thesis_tag: ${input.decision.thesisTag ?? "n/a"}`,
      `entry_market_regime: ${input.decision.regime ?? "n/a"}`,
      `lesson: ${lesson}`
    ].join("\n");
    return await storeContexts(
      [
        {
          text,
          metadata: {
            symbol,
            source: "socratic-lesson",
            timestamp: new Date().toISOString(),
            accession,
            doc_type: "lesson",
            memory_scope: "account",
            decision_id: input.decision.id,
            ...(input.decision.runId ? { run_id: input.decision.runId } : {}),
            ...(input.decision.thesisTag ? { thesis_tag: input.decision.thesisTag } : {}),
            ...(input.decision.regime ? { entry_market_regime: input.decision.regime } : {}),
            ...(input.decision.connectedAccountId ? { connected_account_id: input.decision.connectedAccountId } : {})
          }
        }
      ],
      input.decision.userId,
      { dedupKeyPrefix: "lesson", scope: "private" }
    );
  } catch (err) {
    console.warn("[socratic-memory] lesson vector write failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

export function indexSocraticDecisionMemory(decision: SocraticDecisionCase): Promise<StoreContextsResult> {
  const key = `${decision.userId}:${decision.id}`;
  const prior = decisionIndexQueues.get(key);
  const run = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(async () => {
    const { getConnectedAccount, getSocraticDecisionCase } = await import("./db");
    const {
      getCurrentVectorProviderAuthority,
      managedVectorLedgerAuthority,
      storeContexts
    } = await import("./vector-db");
    const current = getSocraticDecisionCase(decision.id, decision.userId) ?? decision;
    const accountEnvironment = current.connectedAccountId
      ? getConnectedAccount(current.connectedAccountId, current.userId)?.environment
      : undefined;
    const fmp = await import("./web-sources/fmp-transcripts");
    const provenance = fmp.fmpTranscriptDerivedProvenance([
      ...current.ragAttributions,
      ...current.evidence,
      ...current.dissent
    ]);
    if (provenance.length === 0) {
      return storeContexts(
        [buildSocraticMemoryDocument(current, accountEnvironment)],
        current.userId,
        { dedupKeyPrefix: "socratic-decision", scope: "private" }
      );
    }

    // Centralize licensed-memory indexing here so initial decisions and every later lifecycle
    // re-index use the same generation/work fence. A secondary call site cannot accidentally
    // create an untracked FMP-derived vector by omitting an option.
    const claim = fmp.captureFmpTranscriptRightsGeneration();
    if (!claim) return { attempted: 0, indexed: 0, skipped: true };
    const authorityGuard = {
      assertOwnership: () => fmp.assertFmpTranscriptRightsGeneration(claim)
    };
    const providerAuthority = await getCurrentVectorProviderAuthority({
      userId: current.userId,
      leaseGuard: authorityGuard
    });
    authorityGuard.assertOwnership();
    // A durable deletion receipt must identify the physical provider before any upsert can occur.
    // If the index does not yet exist or cannot be described, skip this derivative rather than
    // creating provider work whose future erasure cannot be proved.
    if (!providerAuthority) {
      return { attempted: 0, indexed: 0, skipped: true, unconfigured: true };
    }
    const ledgerAuthority = managedVectorLedgerAuthority();
    const providerWorkId = `fmp-derived:index:${current.id}:${claim.generation}:${globalThis.crypto.randomUUID()}`;
    const providerVectorId = await fmpDerivedSocraticMemoryVectorId(current, claim.generation);
    fmp.persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "strategy-decision",
      artifactId: current.id,
      userId: current.userId,
      provenance,
      providerWorkId,
      providerVectorId,
      providerAuthority,
      ledgerAuthority,
      write: () => undefined
    });

    const abortController = new AbortController();
    const abortLostWork = (reason: unknown) => {
      if (!abortController.signal.aborted) {
        abortController.abort(reason instanceof Error ? reason : new Error(String(reason)));
      }
    };
    const leaseGuard = {
      signal: abortController.signal,
      expectedProviderAuthority: providerAuthority,
      expectedLedgerAuthority: ledgerAuthority,
      assertOwnership: () => fmp.assertFmpTranscriptDerivedProviderWorkOwnership(providerWorkId, claim)
    };
    leaseGuard.assertOwnership();
    const heartbeat = setInterval(() => {
      try {
        if (!fmp.renewFmpTranscriptDerivedProviderWork(providerWorkId, claim)) {
          throw new Error("FMP transcript derived provider-work lease was lost.");
        }
      } catch (error) {
        abortLostWork(error);
      }
    }, 5 * 60_000);
    heartbeat.unref?.();
    let terminalOutcome: "completed" | "no_provider_write" | "provider_write_unknown" =
      "provider_write_unknown";
    try {
      const result = await storeContexts(
        [buildSocraticMemoryDocument(current, accountEnvironment, {
          fmpRightsGeneration: claim.generation,
          fmpProviderVectorId: providerVectorId
        })],
        current.userId,
        { dedupKeyPrefix: "socratic-decision", scope: "private", leaseGuard }
      );
      terminalOutcome = result.indexed > 0
        ? "completed"
        : result.error !== undefined
          ? "provider_write_unknown"
          : "no_provider_write";
      return result;
    } finally {
      clearInterval(heartbeat);
      fmp.completeFmpTranscriptDerivedProviderWork(providerWorkId, terminalOutcome);
    }
  });
  decisionIndexQueues.set(key, run);
  void run.finally(() => {
    if (decisionIndexQueues.get(key) === run) decisionIndexQueues.delete(key);
  }).catch(() => undefined);
  return run;
}

function sha256Hex16(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/**
 * Standalone `doc_type: "coach-note"` vector per owner note (one per note, never overwritten by a
 * sibling — `noteOrdinal` bakes uniqueness into `accession` so global content-hash dedup can never
 * eat a sibling note). This is what EPISODIC_DOC_TYPES/coachingChunks retrieval actually consumes;
 * `buildSocraticMemoryDocument`'s `coach_notes:` line only renders the live in-row window, so a
 * note that ages off the live cap (db-socratic.ts COACH_NOTES_LIVE_CAP) remains retrievable via
 * this vector even after it leaves the parent decision doc's text.
 */
export function buildCoachNoteMemoryDocument(
  decision: SocraticDecisionCase,
  note: string,
  noteOrdinal: number,
  appendedAt: string,
  accountEnvironment?: "paper" | "live"
): ContextDocument {
  const symbol = decision.symbol ?? "PORTFOLIO";
  const text = [
    "Owner coaching note",
    `ticker: ${symbol}`,
    `decision_id: ${decision.id}`,
    `note_seq: ${noteOrdinal}`,
    `timestamp: ${appendedAt}`,
    `thesis_tag: ${decision.thesisTag ?? "n/a"}`,
    `entry_market_regime: ${decision.regime ?? "n/a"}`,
    `note: ${compact(note)}`
  ].join("\n");

  return {
    text,
    metadata: {
      symbol,
      source: "socratic-coach-note",
      timestamp: appendedAt,
      accession: `${decision.id}:coach:${noteOrdinal}`,
      doc_type: "coach-note",
      memory_scope: "account",
      decision_id: decision.id,
      ...(decision.thesisTag ? { thesis_tag: decision.thesisTag } : {}),
      ...(decision.regime ? { entry_market_regime: decision.regime } : {}),
      ...(decision.connectedAccountId ? { connected_account_id: decision.connectedAccountId } : {}),
      ...(accountEnvironment ? { account_environment: accountEnvironment } : {})
    }
  };
}

/**
 * Best-effort: resolves the decision's account environment, builds the coach-note doc, and
 * upserts it. Errors propagate to the caller (db-socratic.ts call sites catch + emit the
 * `socratic_vector_write_degraded` receipt) — never blocks or fails the coach-note append itself.
 */
export async function indexCoachNoteMemory(
  decision: SocraticDecisionCase,
  note: string,
  noteOrdinal: number,
  appendedAt: string
): Promise<void> {
  const { getConnectedAccount } = await import("./db");
  const { storeContexts } = await import("./vector-db");
  const accountEnvironment = decision.connectedAccountId
    ? getConnectedAccount(decision.connectedAccountId, decision.userId)?.environment
    : undefined;
  const result = await storeContexts(
    [buildCoachNoteMemoryDocument(decision, note, noteOrdinal, appendedAt, accountEnvironment)],
    decision.userId,
    { dedupKeyPrefix: "coach-note", scope: "private" }
  );
  if (result.skipped || (result.budgetSkipped ?? 0) > 0 || (result.writeUnitBudgetSkipped ?? 0) > 0) {
    console.warn("[socratic-memory] coach-note vector write skipped:", JSON.stringify({ decisionId: decision.id, noteOrdinal, result }));
  }
}

/**
 * Standalone `doc_type: "lesson"` vector for an owner-promoted lesson
 * (`attachSocraticDecisionCoachPrimitives` `promoteTo: "lesson"`). `vector_id` is derived from the
 * lesson text (stable per distinct lesson string), so re-promoting identical text after it has
 * aged out of the `lessons` slice(-12) cap is an idempotent overwrite, never a duplicate sibling —
 * the caller (db-socratic.ts) additionally guards against re-emitting for text already present in
 * `decision.lessons`.
 */
export function buildPromotedLessonDocument(
  decision: SocraticDecisionCase,
  lessonText: string,
  accountEnvironment?: "paper" | "live"
): ContextDocument {
  const symbol = decision.symbol ?? "PORTFOLIO";
  const timestamp = new Date().toISOString();
  const hash = sha256Hex16(lessonText);
  const text = [
    "Owner-promoted lesson",
    `ticker: ${symbol}`,
    `decision_id: ${decision.id}`,
    `thesis_tag: ${decision.thesisTag ?? "n/a"}`,
    `entry_market_regime: ${decision.regime ?? "n/a"}`,
    `timestamp: ${timestamp}`,
    `lesson: ${compact(lessonText)}`
  ].join("\n");

  return {
    text,
    metadata: {
      symbol,
      source: "socratic-lesson",
      timestamp,
      accession: `${decision.id}:lesson:${hash}`,
      vector_id: `socratic-lesson:${decision.id}:${hash}`,
      doc_type: "lesson",
      memory_scope: "account",
      decision_id: decision.id,
      ...(decision.thesisTag ? { thesis_tag: decision.thesisTag } : {}),
      ...(decision.regime ? { entry_market_regime: decision.regime } : {}),
      ...(decision.connectedAccountId ? { connected_account_id: decision.connectedAccountId } : {}),
      ...(accountEnvironment ? { account_environment: accountEnvironment } : {})
    }
  };
}

/**
 * Best-effort: resolves the decision's account environment, builds the promoted-lesson doc, and
 * upserts it. Errors propagate to the caller (db-socratic.ts catches + emits the
 * `socratic_vector_write_degraded` receipt) — never blocks or fails the promotion itself.
 */
export async function indexPromotedLessonMemory(decision: SocraticDecisionCase, lessonText: string): Promise<void> {
  const { getConnectedAccount } = await import("./db");
  const { storeContexts } = await import("./vector-db");
  const accountEnvironment = decision.connectedAccountId
    ? getConnectedAccount(decision.connectedAccountId, decision.userId)?.environment
    : undefined;
  const result = await storeContexts(
    [buildPromotedLessonDocument(decision, lessonText, accountEnvironment)],
    decision.userId,
    { dedupKeyPrefix: "lesson", scope: "private" }
  );
  if (result.skipped || (result.budgetSkipped ?? 0) > 0 || (result.writeUnitBudgetSkipped ?? 0) > 0) {
    console.warn("[socratic-memory] promoted-lesson vector write skipped:", JSON.stringify({ decisionId: decision.id, result }));
  }
}
